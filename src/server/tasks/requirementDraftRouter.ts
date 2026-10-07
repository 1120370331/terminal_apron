import { Router, type NextFunction, type Request, type Response } from "express";
import type { AuthUser } from "../../shared/types.js";
import type { RequirementDraftEvent } from "../../shared/requirementDraftTypes.js";
import { RequirementDraftService } from "./requirementDraftService.js";
import { RequirementDraftError } from "./requirementDraftStore.js";

export type RequirementDraftServiceProvider = (user: AuthUser) => Promise<RequirementDraftService>;

export function createRequirementDraftRouter(provider: RequirementDraftServiceProvider): Router {
  const router = Router();
  // Also guard standalone/isolated mounts: the provider never receives an untrusted body owner.
  router.use((_req, res, next) => { if (!res.locals.user) { res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Authentication required", retryable: false } }); return; } next(); });
  router.post("/", route(async (req, res, service) => res.status(201).json(service.create(req.body))));
  router.get("/:draftId", route(async (req, res, service) => res.json(service.get(param(req, "draftId")))));
  router.post("/:draftId/operations", route(async (req, res, service) => res.json(service.update(param(req, "draftId"), req.body))));
  router.post("/:draftId/conversation", route(async (req, res, service) => res.json(await service.ensureConversation(param(req, "draftId")))));
  router.get("/:draftId/conversation", route(async (req, res, service) => res.json(await service.conversation(param(req, "draftId")))));
  router.post("/:draftId/turns", route(async (req, res, service) => res.status(202).json(await service.send(param(req, "draftId"), req.body))));
  router.post("/:draftId/interrupt", route(async (req, res, service) => {
    if (typeof req.body?.expectedTurnId !== "string" || !req.body.expectedTurnId) throw new RequirementDraftError(400, "INVALID_INPUT", "expectedTurnId is required");
    res.json(await service.interrupt(param(req, "draftId"), req.body.expectedTurnId));
  }));
  router.get("/:draftId/events", route(async (req, res, service) => {
    const draftId = param(req, "draftId");
    const cursor = req.header("Last-Event-ID") ?? req.query.after ?? "0";
    if (typeof cursor !== "string" || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new RequirementDraftError(400, "INVALID_INPUT", "Invalid event cursor");
    const after = Number(cursor);
    // Subscribe BEFORE reading the durable replay, buffering events to avoid a replay/live gap.
    const queued: RequirementDraftEvent[] = [];
    let replaying = true, last = after;
    const listener = (event: RequirementDraftEvent) => {
      if (event.draftId !== draftId || res.writableEnded) return;
      if (replaying) queued.push(event);
      else if (event.eventId > last) { writeEvent(res, event); last = event.eventId; }
    };
    service.on("event", listener);
    let heartbeat: NodeJS.Timeout | undefined;
    const cleanup = () => { if (heartbeat) clearInterval(heartbeat); service.off("event", listener); };
    res.once("close", cleanup);
    try {
      let replay = service.eventsAfter(draftId, after);
      res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      res.flushHeaders(); res.write("retry: 2000\n");
      if (!replay.gap) for (const event of replay.events) writeEvent(res, event);
      last = replay.eventId;
      writeEvent(res, { kind: replay.gap ? "resync_required" : "ready", draftId, eventId: last, draft: replay.draft });
      replaying = false;
      for (const event of queued) listener(event);
      // Poll persisted events too: another store/service may have written this user's draft.
      heartbeat = setInterval(() => {
        if (res.writableEnded) return;
        try {
          replay = service.eventsAfter(draftId, last);
          if (replay.gap) { last = replay.eventId; writeEvent(res, { kind: "resync_required", draftId, eventId: last, draft: replay.draft }); }
          else for (const event of replay.events) listener(event);
          res.write(`: keepalive ${Date.now()}\n\n`);
        } catch { cleanup(); res.end(); }
      }, 1000);
      heartbeat.unref();
    } catch (error) { cleanup(); throw error; }
  }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const known = error instanceof RequirementDraftError ? error : new RequirementDraftError(503, "CODEX_UNAVAILABLE", "Draft collaboration is unavailable");
    res.status(known.status).json({ error: { code: known.code, message: known.message, retryable: known.status >= 500, ...known.details } });
  });
  return router;

  function route(handler: (req: Request, res: Response, service: RequirementDraftService) => Promise<unknown>) {
    return async (req: Request, res: Response, next: NextFunction) => { try { await handler(req, res, await provider(res.locals.user as AuthUser)); } catch (error) { next(error); } };
  }
}
function param(req: Request, name: string): string { const value = req.params[name]; return Array.isArray(value) ? value[0] : value; }
function writeEvent<T extends { eventId: number }>(res: Response, event: T): void { res.write(`id: ${event.eventId}\nevent: draft-event\ndata: ${JSON.stringify(event)}\n\n`); }
