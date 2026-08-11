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
  TaskStatus,
  UpdateTaskInput,
  UpdateTaskProjectInput
} from "../../shared/taskTypes.js";
import { TaskConflictError, TaskStore, TaskValidationError } from "./taskStore.js";

const MAX_SCREENSHOT_FILES = 8;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

const uploadScreenshots = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_SCREENSHOT_FILES,
    fileSize: MAX_SCREENSHOT_BYTES
  }
}).array("files", MAX_SCREENSHOT_FILES);

export type TaskStoreProvider = (user: AuthUser) => Promise<TaskStore>;

export function createTaskRouter(storeForUser: TaskStoreProvider): Router {
  const router = Router();

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const store = await requestStore(res, storeForUser);
      res.json(
        store.list({
          query: typeof req.query.q === "string" ? req.query.q : undefined,
          status: typeof req.query.status === "string" ? (req.query.status as TaskStatus) : undefined,
          project: typeof req.query.project === "string" ? req.query.project : undefined,
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
      const store = await requestStore(res, storeForUser);
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
      res.setHeader("Content-Type", attachment.mimeType);
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(attachment.filePath);
    })
  );

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

function validateScreenshot(file: Express.Multer.File): {
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
