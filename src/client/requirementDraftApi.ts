import type { CreateRequirementDraftInput, RequirementDraftConversation, RequirementDraftErrorEnvelope, RequirementDraftEvent, RequirementDraftSnapshot, RequirementDraftSyncEvent, RequirementDraftTurnReceipt, RequirementDraftUpdateResult, StartRequirementDraftTurnInput, UpdateRequirementDraftInput } from "../shared/requirementDraftTypes";

export class RequirementDraftApiError extends Error {
  constructor(readonly status: number, readonly detail: RequirementDraftErrorEnvelope["error"]) { super(detail.message); }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequirementDraftApiError(response.status, body.error ?? { code: "REQUEST_FAILED", message: response.statusText, retryable: response.status >= 500 });
  return body as T;
}
const root = "/api/requirement-drafts";
const path = (draftId: string) => `${root}/${encodeURIComponent(draftId)}`;
export const requirementDraftApi = {
  create: (input: CreateRequirementDraftInput) => request<RequirementDraftSnapshot>(root, { method: "POST", body: JSON.stringify(input) }),
  get: (draftId: string) => request<RequirementDraftSnapshot>(path(draftId)),
  update: (draftId: string, input: UpdateRequirementDraftInput) => request<RequirementDraftUpdateResult>(`${path(draftId)}/operations`, { method: "POST", body: JSON.stringify(input) }),
  conversation: (draftId: string) => request<RequirementDraftConversation>(`${path(draftId)}/conversation`),
  ensureConversation: (draftId: string) => request<{ draftId: string; threadId: string }>(`${path(draftId)}/conversation`, { method: "POST" }),
  send: (draftId: string, input: StartRequirementDraftTurnInput) => request<RequirementDraftTurnReceipt>(`${path(draftId)}/turns`, { method: "POST", body: JSON.stringify(input) }),
  interrupt: (draftId: string, expectedTurnId: string) => request(`${path(draftId)}/interrupt`, { method: "POST", body: JSON.stringify({ expectedTurnId }) }),
  subscribe: (draftId: string, after: number, onEvent: (event: RequirementDraftEvent | RequirementDraftSyncEvent) => void, onConnection: (connected: boolean) => void) => {
    const source = new EventSource(`${path(draftId)}/events?after=${after}`, { withCredentials: true });
    source.addEventListener("error", () => onConnection(false));
    source.addEventListener("draft-event", message => {
      try {
        const event = JSON.parse((message as MessageEvent).data) as RequirementDraftEvent | RequirementDraftSyncEvent;
        if (event.draftId !== draftId || !Number.isSafeInteger(event.eventId)) return;
        if (event.kind === "ready" || event.kind === "resync_required") onConnection(true);
        onEvent(event);
      } catch { /* Ignore malformed messages; reconnect snapshots remain authoritative. */ }
    });
    return source;
  }
};
