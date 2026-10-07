import { Router, type NextFunction, type Request, type Response } from "express";
import type { AuthUser } from "../../shared/types.js";
import type { CreateTaskConversationInput, StartTaskTurnInput, SteerTaskTurnInput, TaskApprovalDecision, TaskConversationEvent, UpdateTaskConversationPreferencesInput } from "../../shared/taskConversationTypes.js";
import { TaskConversationService, TaskConversationServiceError } from "./taskConversationService.js";

export type TaskConversationServiceProvider = (user: AuthUser) => Promise<TaskConversationService>;

export function createTaskConversationRouter(serviceForUser: TaskConversationServiceProvider): Router {
  const router = Router({ mergeParams: true });
  router.get("/", route(serviceForUser, async (req, res, service) => res.json(await service.list(param(req, "taskId")))));
  router.get("/models", route(serviceForUser, async (_req, res, service) => res.json(await service.models())));
  router.get("/preferences", route(serviceForUser, async (req, res, service) => res.json(service.preferences(param(req, "taskId")))));
  router.patch("/preferences", route(serviceForUser, async (req, res, service) => res.json(await service.updatePreferences(param(req, "taskId"), req.body as UpdateTaskConversationPreferencesInput))));
  router.post("/default", route(serviceForUser, async (req, res, service) => res.status(200).json(await service.ensureDefault(param(req, "taskId")))));
  router.post("/", route(serviceForUser, async (req, res, service) => res.status(201).json(await service.create(param(req, "taskId"), req.body as CreateTaskConversationInput))));
  router.get("/events", route(serviceForUser, async (req, res, service) => {
    const taskId = param(req, "taskId"); service.store.get(taskId) || notFound();
    const last = Number(req.header("Last-Event-ID") ?? 0) || 0;
    const replay = service.manager.eventsAfter(last, taskId);
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" }); res.flushHeaders(); res.write("retry: 2000\n");
    if (replay.gap) { writeEvent(res, { sequence: replay.events.at(-1)?.sequence ?? 0, kind: "resync_required", taskId, occurredAt: new Date().toISOString(), payload: {} }); res.end(); return; }
    for (const event of replay.events) writeEvent(res, event);
    const ready: TaskConversationEvent = { sequence: replay.events.at(-1)?.sequence ?? last, kind: "ready", taskId, occurredAt: new Date().toISOString(), payload: {} }; writeEvent(res, ready);
    const listener = (event: TaskConversationEvent) => { if (event.taskId === taskId && !res.writableEnded) writeEvent(res, event); };
    service.manager.on("event", listener); const heartbeat = setInterval(() => res.write(`: keepalive ${Date.now()}\n\n`), 15_000); heartbeat.unref();
    res.once("close", () => { clearInterval(heartbeat); service.manager.off("event", listener); });
  }));
  router.get("/:threadId", route(serviceForUser, async (req, res, service) => res.json(await service.read(param(req, "taskId"), param(req, "threadId"), Number(req.query.limit ?? 50), typeof req.query.beforeTurnId === "string" ? req.query.beforeTurnId : undefined))));
  router.patch("/:threadId", route(serviceForUser, async(req,res,service)=>res.json(await service.rename(param(req,"taskId"),param(req,"threadId"),String(req.body?.displayName??"")))));
  router.post("/:threadId/archive", route(serviceForUser, async(req,res,service)=>res.json(await service.archive(param(req,"taskId"),param(req,"threadId")))));
  router.post("/:threadId/turns", route(serviceForUser, async (req, res, service) => res.status(202).json(await service.send(param(req, "taskId"), param(req, "threadId"), req.body as StartTaskTurnInput))));
  router.post("/:threadId/steer", route(serviceForUser, async (req, res, service) => res.status(202).json(await service.steer(param(req, "taskId"), param(req, "threadId"), req.body as SteerTaskTurnInput))));
  router.post("/:threadId/interrupt", route(serviceForUser, async (req, res, service) => { const turnId = String(req.body?.expectedTurnId ?? ""); if (!turnId) throw new TaskConversationServiceError(400,"INVALID_INPUT","expectedTurnId is required"); res.status(202).json(await service.interrupt(param(req,"taskId"),param(req,"threadId"),turnId)); }));
  router.post("/:threadId/approvals/:token", route(serviceForUser, async (req, res, service) => { const decision = req.body?.decision as TaskApprovalDecision; if (!(["accept","accept_for_session","decline"] as string[]).includes(decision)) throw new TaskConversationServiceError(400,"INVALID_INPUT","invalid approval decision"); service.resolveApproval(param(req,"taskId"),param(req,"threadId"),param(req,"token"),decision); res.json({ resolved:true, resolution:decision, resolvedAt:new Date().toISOString() }); }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const known = error instanceof TaskConversationServiceError ? error : new TaskConversationServiceError(503,"CODEX_UNAVAILABLE",error instanceof Error ? error.message : "Codex conversation failed");
    res.status(known.status).json({ error: { code: known.code, message: known.message, retryable: known.status >= 500, ...known.details } });
  });
  return router;
}

function route(provider: TaskConversationServiceProvider, handler: (req: Request,res: Response,service: TaskConversationService) => Promise<unknown> | unknown) { return async (req: Request,res: Response,next: NextFunction) => { try { await handler(req,res,await provider(res.locals.user as AuthUser)); } catch(error){ next(error); } }; }
function param(req: Request, name: string): string { const value=req.params[name]; return Array.isArray(value) ? value[0] : value; }
function notFound(): never { throw new TaskConversationServiceError(404,"TASK_NOT_FOUND","Task not found"); }
function writeEvent(res: Response,event: TaskConversationEvent){ res.write(`id: ${event.sequence}\nevent: conversation-event\ndata: ${JSON.stringify(event)}\n\n`); }
