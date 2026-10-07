import type { RequirementDraftFields, RequirementDraftSnapshot } from "../../shared/requirementDraftTypes";

export const requirementFields = ["title", "descriptionMd", "acceptanceCriteriaMd"] as const;
export type RequirementField = typeof requirementFields[number];
interface Edit { from: number; to: number; text: string }
export interface TextConflict {
  from: number;
  to: number;
  base: string;
  mine: string;
  assistant: string;
  /** The merged document when this conflict was detected; used to rebase choices. */
  document: string;
}
export interface RequirementConflict extends TextConflict { id: string; field: RequirementField }
export interface RequirementDraftState {
  server: RequirementDraftSnapshot;
  fields: RequirementDraftFields;
  conflicts: RequirementConflict[];
  eventId: number;
}

function overlap(a: Edit, b: Edit): boolean {
  if (a.from === a.to) return a.from >= b.from && a.from <= b.to;
  if (b.from === b.to) return b.from >= a.from && b.from <= a.to;
  return a.from < b.to && b.from < a.to;
}

/** Bounded LCS. Long documents use lines, then refine small changed spans by character. */
function edits(base: string, value: string): Edit[] {
  if (base === value) return [];
  let prefix = 0, suffix = 0;
  while (prefix < base.length && prefix < value.length && base[prefix] === value[prefix]) prefix++;
  while (suffix < base.length - prefix && suffix < value.length - prefix && base[base.length - suffix - 1] === value[value.length - suffix - 1]) suffix++;
  const word = (character: string | undefined) => Boolean(character && /[A-Za-z0-9_]/.test(character));
  while (prefix > 0 && word(base[prefix - 1]) && (word(base[prefix]) || word(value[prefix]))) prefix--;
  while (suffix > 0 && word(base[base.length - suffix]) && (word(base[base.length - suffix - 1]) || word(value[value.length - suffix - 1]))) suffix--;
  const oldText = base.slice(prefix, base.length - suffix), newText = value.slice(prefix, value.length - suffix);
  const chars = oldText.length * newText.length <= 250_000;
  const split = (text: string) => chars ? text.match(/[A-Za-z0-9_]+|[\s\S]/g) ?? [] : text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(oldText), b = split(newText);
  if ((a.length + 1) * (b.length + 1) > 1_000_000) return [{ from: prefix, to: base.length - suffix, text: newText }];
  const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const result: Edit[] = [];
  let i = 0, j = 0, offset = prefix, pending: Edit | undefined;
  const flush = () => { if (pending) { result.push(pending); pending = undefined; } };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); offset += a[i++].length; j++; }
    else {
      pending ??= { from: offset, to: offset, text: "" };
      if (j < b.length && (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) pending.text += b[j++];
      else { offset += a[i++].length; pending.to = offset; }
    }
  }
  flush();
  if (chars) return result;
  return result.flatMap(edit => {
    const before = base.slice(edit.from, edit.to);
    return before.length * edit.text.length <= 250_000
      ? edits(before, edit.text).map(part => ({ ...part, from: part.from + edit.from, to: part.to + edit.from }))
      : [edit];
  });
}

function apply(base: string, from: number, to: number, changes: Edit[]): string {
  let text = "", cursor = from;
  for (const edit of changes) { text += base.slice(cursor, edit.from) + edit.text; cursor = edit.to; }
  return text + base.slice(cursor, to);
}

export function mergeRequirementText(base: string, mine: string, assistant: string): { text: string; conflicts: TextConflict[] } {
  if (mine === base || mine === assistant) return { text: assistant, conflicts: [] };
  if (assistant === base) return { text: mine, conflicts: [] };
  const all = [...edits(base, mine).map(edit => ({ ...edit, side: "mine" as const })), ...edits(base, assistant).map(edit => ({ ...edit, side: "assistant" as const }))].sort((a, b) => a.from - b.from || a.to - b.to);
  const groups: typeof all[] = [];
  for (const edit of all) {
    const group = groups.at(-1);
    if (group?.some(other => overlap(other, edit))) group.push(edit);
    else groups.push([edit]);
  }
  let text = "", cursor = 0;
  const conflicts: TextConflict[] = [];
  for (const group of groups) {
    const from = group[0].from, to = Math.max(...group.map(edit => edit.to));
    text += base.slice(cursor, from);
    const local = group.filter(edit => edit.side === "mine"), remote = group.filter(edit => edit.side === "assistant");
    const localText = apply(base, from, to, local), remoteText = apply(base, from, to, remote);
    if (local.length && remote.length && localText !== remoteText) {
      conflicts.push({ from: text.length, to: text.length + localText.length, base: base.slice(from, to), mine: localText, assistant: remoteText, document: "" });
      text += localText;
    } else text += remote.length ? remoteText : localText;
    cursor = to;
  }
  text += base.slice(cursor);
  conflicts.forEach(conflict => { conflict.document = text; });
  return { text, conflicts };
}

export function initialRequirementState(server: RequirementDraftSnapshot, fields = server.fields): RequirementDraftState {
  return { server, fields: { ...fields }, conflicts: [], eventId: 0 };
}

/** Text and attachment metadata are restored before the assistant is mounted.
 * Assistant fields are also a fallback for drafts written by older edit forms. */
export function latestPersistedRequirementFields(
  form?: { fields: RequirementDraftFields; savedAt?: number },
  assistant?: { fields: RequirementDraftFields; savedAt?: number }
): RequirementDraftFields | undefined {
  if (!form) return assistant?.fields;
  if (!assistant) return form.fields;
  return (assistant.savedAt ?? 0) > (form.savedAt ?? 0) ? assistant.fields : form.fields;
}

/** Restoring a baseline is not a user edit. Merge only input made since opening;
 * an authoritative restored form already includes blob URL remapping. */
export function restoreRequirementState(saved: RequirementDraftState, opening: RequirementDraftFields, current: RequirementDraftFields, formRestored = false): RequirementDraftState {
  if (formRestored) return { ...saved, fields: { ...current } };
  const fields = { ...saved.fields }, conflicts = [...saved.conflicts];
  for (const field of requirementFields) {
    const merged = mergeRequirementText(opening[field], current[field], saved.fields[field]);
    fields[field] = merged.text;
    conflicts.push(...merged.conflicts.map((item, index) => ({ ...item, field, id: `restore:${saved.server.version}:${field}:${index}` })));
  }
  return { ...saved, fields, conflicts };
}

/** Replayed or stale snapshots never replace newer local content or version state. */
export function receiveRequirementSnapshot(state: RequirementDraftState, server: RequirementDraftSnapshot, eventId = state.eventId): RequirementDraftState {
  if (server.draftId !== state.server.draftId || server.version < state.server.version) return state;
  if (server.version === state.server.version) return { ...state, eventId: Math.max(eventId, state.eventId) };
  const fields = { ...state.fields }, conflicts = [...state.conflicts];
  for (const field of requirementFields) {
    const merged = mergeRequirementText(state.server.fields[field], state.fields[field], server.fields[field]);
    fields[field] = merged.text;
    conflicts.push(...merged.conflicts.map((conflict, index) => ({ ...conflict, field, id: `${server.version}:${field}:${index}` })));
  }
  return { server, fields, conflicts, eventId: Math.max(eventId, state.eventId) };
}

/** Choices rebase against edits made since the conflict appeared, rather than overwriting. */
export function resolveRequirementConflict(state: RequirementDraftState, id: string, choice: "mine" | "assistant" | "both"): RequirementDraftState {
  const conflict = state.conflicts.find(item => item.id === id);
  if (!conflict) return state;
  const remaining = state.conflicts.filter(item => item.id !== id);
  if (choice === "mine") return { ...state, conflicts: remaining };
  const selected = choice === "both" ? `${conflict.mine}\n${conflict.assistant}` : conflict.assistant;
  const proposed = conflict.document.slice(0, conflict.from) + selected + conflict.document.slice(conflict.to);
  const merged = mergeRequirementText(conflict.document, state.fields[conflict.field], proposed);
  return { ...state, fields: { ...state.fields, [conflict.field]: merged.text }, conflicts: [...remaining, ...merged.conflicts.map((item, index) => ({ ...item, field: conflict.field, id: `${id}:rebase:${index}` }))] };
}

export function requirementPatch(base: RequirementDraftFields, fields: RequirementDraftFields): Partial<RequirementDraftFields> {
  const patch: Partial<RequirementDraftFields> = {};
  for (const field of requirementFields) if (base[field] !== fields[field]) patch[field] = fields[field];
  return patch;
}
