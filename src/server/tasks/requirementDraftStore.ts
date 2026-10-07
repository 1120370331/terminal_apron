import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  CreateRequirementDraftInput, RequirementDraftEvent, RequirementDraftSnapshot,
  RequirementDraftTurnReceipt, RequirementDraftUpdateResult, UpdateRequirementDraftInput
} from "../../shared/requirementDraftTypes.js";
import type { TaskConversationTurn } from "../../shared/taskConversationTypes.js";

export class RequirementDraftError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

interface DraftRow { snapshot: string; thread_id: string | null; thread_pending: number; event_floor: number }
type EventWithoutId = RequirementDraftEvent extends infer E ? E extends RequirementDraftEvent ? Omit<E, "eventId"> : never : never;

/** Separate database: never mutates TaskStore, task state, or submitted task snapshots. */
export class RequirementDraftStore {
  private readonly db: DatabaseSync;
  readonly directory: string;
  constructor(dataDir: string, readonly ownerId: string) {
    this.directory = path.resolve(dataDir, "requirement-drafts");
    fs.mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(this.directory, "drafts.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, snapshot TEXT NOT NULL, thread_id TEXT, thread_pending INTEGER NOT NULL DEFAULT 0, event_floor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS creates (owner TEXT NOT NULL, operation_id TEXT NOT NULL, hash TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(owner,operation_id));
      CREATE TABLE IF NOT EXISTS operations (draft_id TEXT NOT NULL, operation_id TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(draft_id,operation_id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS draft_events ON events(draft_id,id);
      CREATE TABLE IF NOT EXISTS turns (draft_id TEXT NOT NULL, operation_id TEXT NOT NULL, hash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(draft_id,operation_id));`);
    this.db.exec("CREATE TABLE IF NOT EXISTS conversation_projections (draft_id TEXT PRIMARY KEY, turns TEXT NOT NULL)");
  }

  close(): void { this.db.close(); }

  create(input: CreateRequirementDraftInput): RequirementDraftSnapshot {
    return this.transaction(() => {
      const digest = fingerprint(input);
      const prior = this.db.prepare("SELECT hash,snapshot FROM creates WHERE owner=? AND operation_id=?").get(this.ownerId, input.operationId) as { hash: string; snapshot: string } | undefined;
      if (prior) { sameOperation(prior.hash, digest); return JSON.parse(prior.snapshot); }
      const now = new Date().toISOString();
      const draft: RequirementDraftSnapshot = { draftId: randomUUID(), version: 1, fields: input.fields, taskId: input.taskId, sourceTaskRevision: input.sourceTaskRevision, createdAt: now, updatedAt: now };
      this.db.prepare("INSERT INTO drafts(id,owner,snapshot) VALUES(?,?,?)").run(draft.draftId, this.ownerId, JSON.stringify(draft));
      this.db.prepare("INSERT INTO creates VALUES(?,?,?,?)").run(this.ownerId, input.operationId, digest, JSON.stringify(draft));
      return draft;
    });
  }

  get(draftId: string): RequirementDraftSnapshot { return JSON.parse(this.row(draftId).snapshot); }

  update(draftId: string, input: UpdateRequirementDraftInput, actor: "user" | "codex"): RequirementDraftUpdateResult {
    return this.transaction(() => {
      const current = this.get(draftId), digest = fingerprint({ ...input, actor });
      const prior = this.db.prepare("SELECT hash,result FROM operations WHERE draft_id=? AND operation_id=?").get(draftId, input.operationId) as { hash: string; result: string } | undefined;
      if (prior) { sameOperation(prior.hash, digest); return { ...JSON.parse(prior.result), replayed: true }; }
      checkVersion(current, input.baseVersion);
      const draft: RequirementDraftSnapshot = { ...current, fields: { ...current.fields, ...input.patch }, version: current.version + 1, updatedAt: new Date().toISOString() };
      this.db.prepare("UPDATE drafts SET snapshot=? WHERE id=? AND owner=?").run(JSON.stringify(draft), draftId, this.ownerId);
      const event = this.appendInside(draftId, { kind: "draft_updated", draftId, version: draft.version, operationId: input.operationId, actor, draft, occurredAt: draft.updatedAt });
      const result: RequirementDraftUpdateResult = { operationId: input.operationId, draft, eventId: event.eventId, replayed: false };
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(draftId, input.operationId, digest, JSON.stringify(result));
      return result;
    });
  }

  eventsAfter(draftId: string, after: number): { events: RequirementDraftEvent[]; gap: boolean; eventId: number; draft: RequirementDraftSnapshot } {
    return this.transaction(() => {
      const row = this.row(draftId);
      const records = this.db.prepare("SELECT id,payload FROM events WHERE draft_id=? AND id>? ORDER BY id").all(draftId, after) as Array<{ id: number; payload: string }>;
      const eventId = Number((this.db.prepare("SELECT MAX(id) AS id FROM events WHERE draft_id=?").get(draftId) as { id: number | null }).id ?? 0);
      return { events: records.map(entry => ({ ...JSON.parse(entry.payload), eventId: entry.id })), gap: after < row.event_floor || after > eventId, eventId, draft: JSON.parse(row.snapshot) };
    });
  }

  append(draftId: string, event: Omit<Extract<RequirementDraftEvent, { kind: "conversation" }>, "eventId">): RequirementDraftEvent {
    return this.transaction(() => { this.row(draftId); return this.appendInside(draftId, event); });
  }

  thread(draftId: string): string | undefined { return this.row(draftId).thread_id ?? undefined; }
  threadPending(draftId: string): boolean { return Boolean(this.row(draftId).thread_pending); }
  boundDrafts(): Array<{ draftId: string; threadId: string }> {
    return (this.db.prepare("SELECT id,thread_id FROM drafts WHERE owner=? AND thread_id IS NOT NULL").all(this.ownerId) as Array<{ id: string; thread_id: string }>).map(row => ({ draftId: row.id, threadId: row.thread_id }));
  }
  reserveThread(draftId: string): void {
    this.transaction(() => {
      const row = this.row(draftId);
      if (row.thread_id) throw new RequirementDraftError(409, "THREAD_ALREADY_CREATED", "Conversation was created concurrently; reload it");
      if (row.thread_pending) throw new RequirementDraftError(503, "THREAD_CREATE_UNCERTAIN", "Conversation creation is pending; do not start a duplicate thread");
      this.db.prepare("UPDATE drafts SET thread_pending=1 WHERE id=?").run(draftId);
    });
  }
  finishThread(draftId: string, threadId?: string): void {
    this.row(draftId);
    this.db.prepare("UPDATE drafts SET thread_pending=0,thread_id=? WHERE id=?").run(threadId ?? null, draftId);
  }

  receipts(draftId: string): RequirementDraftTurnReceipt[] {
    this.row(draftId);
    return (this.db.prepare("SELECT receipt FROM turns WHERE draft_id=? ORDER BY rowid").all(draftId) as Array<{ receipt: string }>).map(row => JSON.parse(row.receipt));
  }

  reserveTurn(draftId: string, operationId: string, baseVersion: number, text: string, threadId: string): { receipt: RequirementDraftTurnReceipt; duplicate: boolean } {
    return this.transaction(() => {
      const current = this.get(draftId), digest = fingerprint({ baseVersion, text });
      const prior = this.db.prepare("SELECT hash,receipt FROM turns WHERE draft_id=? AND operation_id=?").get(draftId, operationId) as { hash: string; receipt: string } | undefined;
      if (prior) { sameOperation(prior.hash, digest); return { receipt: JSON.parse(prior.receipt), duplicate: true }; }
      checkVersion(current, baseVersion);
      if (this.receipts(draftId).some(entry => entry.state === "reserved" || entry.state === "uncertain")) throw new RequirementDraftError(409, "TURN_OUTCOME_UNKNOWN", "A prior turn is being reconciled");
      const receipt: RequirementDraftTurnReceipt = { operationId, state: "reserved", threadId, snapshot: current };
      this.db.prepare("INSERT INTO turns VALUES(?,?,?,?)").run(draftId, operationId, digest, JSON.stringify(receipt));
      return { receipt, duplicate: false };
    });
  }
  conversationTurns(draftId: string): TaskConversationTurn[] {
    this.row(draftId);
    const row = this.db.prepare("SELECT turns FROM conversation_projections WHERE draft_id=?").get(draftId) as { turns: string } | undefined;
    return row ? JSON.parse(row.turns) : [];
  }
  saveConversationTurns(draftId: string, turns: TaskConversationTurn[]): void {
    this.row(draftId);
    this.db.prepare("INSERT INTO conversation_projections VALUES(?,?) ON CONFLICT(draft_id) DO UPDATE SET turns=excluded.turns").run(draftId, JSON.stringify(turns));
  }
  updateReceipt(draftId: string, receipt: RequirementDraftTurnReceipt): void {
    this.row(draftId);
    this.db.prepare("UPDATE turns SET receipt=? WHERE draft_id=? AND operation_id=?").run(JSON.stringify(receipt), draftId, receipt.operationId);
  }

  private row(draftId: string): DraftRow {
    const row = this.db.prepare("SELECT snapshot,thread_id,thread_pending,event_floor FROM drafts WHERE id=? AND owner=?").get(draftId, this.ownerId) as DraftRow | undefined;
    if (!row) throw new RequirementDraftError(404, "DRAFT_NOT_FOUND", "Draft not found");
    return row;
  }
  private appendInside(draftId: string, event: EventWithoutId): RequirementDraftEvent {
    const eventId = Number(this.db.prepare("INSERT INTO events(draft_id,payload) VALUES(?,?)").run(draftId, JSON.stringify(event)).lastInsertRowid);
    const cutoff = this.db.prepare("SELECT id FROM events WHERE draft_id=? ORDER BY id DESC LIMIT 1 OFFSET 999").get(draftId) as { id: number } | undefined;
    if (cutoff) {
      const removed = this.db.prepare("SELECT MAX(id) AS id FROM events WHERE draft_id=? AND id<?").get(draftId, cutoff.id) as { id: number | null };
      if (removed.id) {
        this.db.prepare("UPDATE drafts SET event_floor=? WHERE id=?").run(removed.id, draftId);
        this.db.prepare("DELETE FROM events WHERE draft_id=? AND id<?").run(draftId, cutoff.id);
      }
    }
    return { ...event, eventId } as RequirementDraftEvent;
  }
  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sameOperation(prior: string, next: string): void {
  if (prior !== next) throw new RequirementDraftError(409, "OPERATION_ID_REUSED", "operationId was already used for different content");
}
export function checkVersion(current: RequirementDraftSnapshot, baseVersion: number): void {
  if (current.version !== baseVersion) throw new RequirementDraftError(409, "DRAFT_VERSION_CONFLICT", "Draft changed; preserve your local edits and reconcile with current", { current });
}
