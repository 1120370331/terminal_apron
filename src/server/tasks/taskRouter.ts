import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { AuthUser } from "../../shared/types.js";
import type {
  CreateTaskProjectInput,
  CreateTaskReportInput,
  CreateTaskInput,
  TaskAttachment,
  TaskAttachmentUploadResponse,
  TaskReleaseStatus,
  TaskStatus,
  UpdateTaskInput,
  UpdateTaskProjectInput
} from "../../shared/taskTypes.js";
import { selectTaskTerminalCwd } from "./taskTerminalContext.js";
import { taskArtifactFormat, TASK_HTML_PREVIEW_POLICY } from "../../shared/taskArtifactTypes.js";
import { TaskConflictError, TaskConversationConflictError, TaskStore, TaskValidationError } from "./taskStore.js";
import { TaskConversationServiceError } from "./taskConversationService.js";

const MAX_SCREENSHOT_FILES = 8;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

// Legacy feedback attachments stored a display title instead of a filename.
// Retain genuine filenames; recover a missing suffix from the stored file.
export function attachmentDelivery(name: string, storedFilename: string, mimeType: string, download = false) {
  const extension = path.extname(storedFilename).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ".bin";
  const basename = path.win32.basename(path.posix.basename(name)).replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/[. ]+$/, "").trim() || "attachment";
  const filename = basename.toLowerCase().endsWith(safeExtension) ? basename : basename + safeExtension;
  const knownTypes: Record<string, string> = { ".html": "text/html", ".htm": "text/html", ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".pdf": "application/pdf", ".json": "application/json", ".csv": "text/csv", ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  const contentType = mimeType.split(";")[0].trim().toLowerCase() === "application/octet-stream" ? knownTypes[extension] ?? mimeType : mimeType;
  const inline = !download && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType);
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return { filename, contentType, disposition: `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encoded}` };
}

const uploadScreenshots = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_SCREENSHOT_FILES,
    fileSize: MAX_SCREENSHOT_BYTES
  }
}).array("files", MAX_SCREENSHOT_FILES);

export type TaskStoreProvider = (user: AuthUser) => Promise<TaskStore>;
export interface TaskTerminalLinkStore {
  unlinkTask(taskId: string): Promise<number>;
}
export type SessionStoreProvider = (user: AuthUser) => Promise<TaskTerminalLinkStore>;
export interface TaskConversationLifecycleService { prepareTaskDeletion(taskId: string): Promise<void>; prepareTaskArchive(taskId:string):Promise<void> }
export type TaskConversationLifecycleProvider = (user: AuthUser) => Promise<TaskConversationLifecycleService>;

export function createTaskRouter(
  storeForUser: TaskStoreProvider,
  sessionStoreForUser?: SessionStoreProvider,
  conversationServiceForUser?: TaskConversationLifecycleProvider
): Router {
  const router = Router();

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      res.json(
        store.list({
          query: typeof req.query.q === "string" ? req.query.q : undefined,
          status: typeof req.query.status === "string" ? (req.query.status as TaskStatus) : undefined,
          releaseStatus:
            typeof req.query.releaseStatus === "string"
              ? (req.query.releaseStatus as TaskReleaseStatus)
              : undefined,
          project: typeof req.query.project === "string" ? req.query.project : undefined,
          group: typeof req.query.group === "string" ? req.query.group : undefined,
          tags: Array.isArray(req.query.tag)
            ? req.query.tag.filter((tag): tag is string => typeof tag === "string")
            : typeof req.query.tag === "string"
              ? [req.query.tag]
              : undefined,
          archived: req.query.archived === "true"
        })
      );
    })
  );

  router.get(
    "/events",
    asyncRoute(async (_req, res) => {
      const store = await requestStore(res, storeForUser);
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write("retry: 2000\n");
      writeServerEvent(res, "ready", { connectedAt: new Date().toISOString() });

      const unsubscribe = store.subscribe((event) => {
        if (!res.writableEnded) {
          writeServerEvent(res, "task-change", event, event.id);
        }
      });
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(`: keepalive ${Date.now()}\n\n`);
        }
      }, 15_000);
      heartbeat.unref();

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      res.once("close", cleanup);
    })
  );

  router.get(
    "/projects",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      res.json(store.projects(req.query.archived === "true"));
    })
  );

  router.get(
    "/groups",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      res.json(store.groups(req.query.archived === "true"));
    })
  );

  router.get(
    "/tags",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      res.json(store.tags(req.query.archived === "true",typeof req.query.project==="string"?req.query.project:undefined,req.query.catalog==="true"));
    })
  );

  router.patch("/:id/tags",asyncRoute(async(req,res)=>{
    const store=await requestStore(res,storeForUser);const task=store.updateTags(routeParam(req,"id"),req.body??{});
    if(!task){res.status(404).json({error:"task not found"});return;}res.json(task);
  }));

  router.post(
    "/projects",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      res.status(201).json(store.createProject(req.body as CreateTaskProjectInput));
    })
  );

  router.patch(
    "/projects/:name",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const project = store.updateProject(routeParam(req, "name"), req.body as UpdateTaskProjectInput);
      if (!project) {
        res.status(404).json({ error: "project not found" });
        return;
      }
      res.json(project);
    })
  );

  router.post(
    "/",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      res.status(201).json(store.create(req.body as CreateTaskInput));
    })
  );

  router.get(
    "/:id",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const task = store.get(routeParam(req, "id"));
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.json(task);
    })
  );

  router.post(
    "/:id/context/refresh",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const task = store.refreshContext(routeParam(req, "id"));
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.json(task);
    })
  );

  router.post(
    "/:id/terminal-context",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const task = store.refreshContext(routeParam(req, "id"));
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.json({ task, cwd: selectTaskTerminalCwd(task) });
    })
  );

  router.patch(
    "/:id",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const task = store.update(routeParam(req, "id"), req.body as UpdateTaskInput);
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.json(task);
    })
  );

  router.post(
    "/:id/archive",
    asyncRoute(async (req, res) => {
      const user = res.locals.user as AuthUser;
      const store = await requestStore(res, storeForUser);
      if (conversationServiceForUser) {
        await (await conversationServiceForUser(user)).prepareTaskArchive(routeParam(req, "id"));
      }
      const task = store.archive(routeParam(req, "id"));
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.json(task);
    })
  );

  router.post(
    "/:id/restore",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const task = store.restore(routeParam(req, "id"));
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.json(task);
    })
  );

  router.delete(
    "/:id",
    asyncRoute(async (req, res) => {
      const user = res.locals.user as AuthUser;
      const store = await storeForUser(user);
      if (conversationServiceForUser) {
        await (await conversationServiceForUser(user)).prepareTaskDeletion(routeParam(req, "id"));
      }
      const removed = store.delete(routeParam(req, "id"));
      if (!removed) {
        res.status(404).json({ error: "task not found" });
        return;
      }

      let unlinkedTerminalCount = 0;
      let terminalUnlinkError: unknown;
      if (sessionStoreForUser) {
        try {
          unlinkedTerminalCount = await (await sessionStoreForUser(user)).unlinkTask(removed.id);
        } catch (error) {
          terminalUnlinkError = error;
          console.error(`Failed to unlink terminals for deleted task ${removed.id}`, error);
        }
      }
      await Promise.all([
        fs.promises.rm(removed.attachmentDirectory, { recursive: true, force: true }),
        fs.promises.rm(removed.contextDirectory, { recursive: true, force: true })
      ]);
      if (removed.parentTaskId) {
        store.refreshContext(removed.parentTaskId);
      }
      if (terminalUnlinkError) {
        res.status(500).json({
          error: "task was deleted, but associated terminals could not be unlinked; refresh before retrying"
        });
        return;
      }
      res.json({ ok: true, taskId: removed.id, unlinkedTerminalCount });
    })
  );

  router.get(
    "/:id/reports",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const reports = store.listReports(routeParam(req, "id"), Number(req.query.limit ?? 50));
      if (!reports) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.json({ reports });
    })
  );

  router.post(
    "/:id/reports",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const task = store.addReport(routeParam(req, "id"), req.body as CreateTaskReportInput);
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.status(201).json(task);
    })
  );

  router.post("/:id/attachments", (req, res, next) => {
    uploadScreenshots(req, res, (error) => {
      if (error) {
        next(error);
        return;
      }
      void handleScreenshotUpload(req, res, storeForUser).catch(next);
    });
  });

  router.get(
    "/:id/attachments/:attachmentId/content",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const attachment = store.attachment(routeParam(req, "id"), routeParam(req, "attachmentId"));
      if (!attachment || !fs.existsSync(attachment.filePath)) {
        res.status(404).json({ error: "attachment not found" });
        return;
      }
      const root = fs.realpathSync(store.attachmentDirectory(attachment.taskId)), target = fs.realpathSync(attachment.filePath), relative = path.relative(root, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) { res.status(404).json({ error: "attachment not found" }); return; }
      const delivery = attachmentDelivery(attachment.name, attachment.storageName, attachment.mimeType, req.query.download === "1");
      res.setHeader("Content-Type", delivery.contentType);
      res.setHeader("Content-Disposition", delivery.disposition);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      res.sendFile(target);
    })
  );

  router.get("/:id/attachments/:attachmentId/preview", asyncRoute(async (req, res) => {
    const store = await requestStore(res, storeForUser);
    const taskId = routeParam(req, "id"), attachment = store.attachment(taskId, routeParam(req, "attachmentId"));
    if (!attachment || !fs.existsSync(attachment.filePath)) { res.status(404).json({ error: "材料不存在或已删除" }); return; }
    const format = taskArtifactFormat(attachment.storageName, attachment.mimeType);
    if (!format) { res.status(415).json({ error: "该材料不支持文档预览，请下载查看" }); return; }
    const root = fs.realpathSync(store.attachmentDirectory(taskId)), target = fs.realpathSync(attachment.filePath), relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) { res.status(404).json({ error: "材料不存在" }); return; }
    if (fs.statSync(target).size > MAX_SCREENSHOT_BYTES) { res.status(413).json({ error: "预览文件不能超过 10 MB" }); return; }
    res.set({ "Content-Type": format === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", "Content-Disposition": "inline", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    if (format === "html") res.set("Content-Security-Policy", `sandbox allow-scripts; ${TASK_HTML_PREVIEW_POLICY}; frame-ancestors 'self'`);
    res.sendFile(target);
  }));

  router.delete(
    "/:id/attachments/:attachmentId",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      const taskId = routeParam(req, "id");
      const removed = store.removeAttachment(taskId, routeParam(req, "attachmentId"));
      if (!removed) {
        res.status(404).json({ error: "attachment not found" });
        return;
      }
      await fs.promises
        .unlink(store.attachmentFilePath(taskId, removed.storageName))
        .catch(() => undefined);
      res.json(removed.task);
    })
  );

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof TaskConversationServiceError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, retryable: error.status >= 500, ...error.details } });
      return;
    }
    if (error instanceof TaskConversationConflictError) {
      res.status(409).json({ error: { code: error.code, message: error.message, retryable: false, ...error.details } });
      return;
    }
    if (error instanceof TaskValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof TaskConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof multer.MulterError) {
      res.status(error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT" ? 413 : 400).json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "每张截图不能超过 10 MB"
            : error.code === "LIMIT_FILE_COUNT"
              ? "每次最多上传 8 张截图"
              : error.message
      });
      return;
    }
    console.error("TaskMonitor request failed", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "task request failed" });
  });

  return router;
}

async function handleScreenshotUpload(
  req: Request,
  res: Response,
  storeForUser: TaskStoreProvider
): Promise<void> {
  const files = (req.files ?? []) as Express.Multer.File[];
  if (files.length === 0) {
    res.status(400).json({ error: "请选择至少一张截图" });
    return;
  }
  const validated = files.map(validateScreenshot);
  const store = await requestStore(res, storeForUser);
  const taskId = routeParam(req, "id");
  if (!store.get(taskId)) {
    res.status(404).json({ error: "task not found" });
    return;
  }

  let task = store.get(taskId);
  const knownAttachmentIds = new Set(task?.attachments.map((attachment) => attachment.id) ?? []);
  const uploadedAttachments: TaskAttachment[] = [];
  for (const file of validated) {
    const storageName = `${crypto.randomUUID()}.${file.extension}`;
    const filePath = path.join(store.attachmentDirectory(taskId), storageName);
    await fs.promises.writeFile(filePath, file.buffer, { flag: "wx" });
    try {
      task = store.addAttachment(taskId, {
        name: file.originalName,
        storageName,
        mimeType: file.mimeType,
        size: file.buffer.length
      });
      const uploaded = task?.attachments.find((attachment) => !knownAttachmentIds.has(attachment.id));
      if (uploaded) {
        knownAttachmentIds.add(uploaded.id);
        uploadedAttachments.push(uploaded);
      }
    } catch (error) {
      await fs.promises.unlink(filePath).catch(() => undefined);
      throw error;
    }
  }

  if (!task) {
    res.status(404).json({ error: "task not found" });
    return;
  }
  const response: TaskAttachmentUploadResponse = {
    attachments: uploadedAttachments,
    task
  };
  res.status(201).json(response);
}

export function validateScreenshot(file: Express.Multer.File): {
  buffer: Buffer;
  extension: string;
  mimeType: string;
  originalName: string;
} {
  const signature = imageSignature(file.buffer);
  if (!signature || signature.mimeType !== file.mimetype.toLowerCase()) {
    throw new TaskValidationError("截图内容与文件类型不匹配，仅支持 PNG、JPEG、WebP 和 GIF");
  }
  return {
    buffer: file.buffer,
    extension: signature.extension,
    mimeType: signature.mimeType,
    originalName: file.originalname || `screenshot.${signature.extension}`
  };
}

function imageSignature(buffer: Buffer): { mimeType: string; extension: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  return null;
}

async function requestStore(res: Response, storeForUser: TaskStoreProvider): Promise<TaskStore> {
  return storeForUser(res.locals.user as AuthUser);
}

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function writeServerEvent(res: Response, event: string, data: unknown, id?: number): void {
  if (id !== undefined) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
