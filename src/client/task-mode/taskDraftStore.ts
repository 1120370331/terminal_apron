import type { TaskItem } from "../../shared/taskTypes";
import type { CreateRequirementDraftInput, StartRequirementDraftTurnInput, UpdateRequirementDraftInput } from "../../shared/requirementDraftTypes";
import type { RequirementDraftState } from "./requirementDraftState";
import type { TaskConversationDetail } from "../../shared/taskConversationTypes";

export interface StoredRequirementAssistant {
  /** Timestamp changes only when fields change, never for a conversation-only event. */
  fieldsSavedAt?: number;
  state?: RequirementDraftState;
  create?: CreateRequirementDraftInput;
  update?: UpdateRequirementDraftInput;
  turn?: StartRequirementDraftTurnInput;
  conversation?: TaskConversationDetail;
}

export interface StoredTaskDraft {
  savedAt?: number;
  title: string;
  description: string;
  acceptance: string;
  project: string;
  repository: string;
  priority: TaskItem["priority"];
  tags?: string[];
  taskId?: string;
  files: Array<{ id: string; name: string; mimeType: string; url: string; file: File }>;
}

const databaseName = "terminal-apron-task-mode-drafts";
const pendingWrites = new Map<string, Promise<void>>();

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("浏览器无法保存本地草稿")); return; }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("草稿数据库不可用"));
  });
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("drafts", mode);
      let writtenValue: T;
      let requestSucceeded = false;
      transaction.onerror = () => reject(transaction.error ?? new Error("草稿保存失败"));
      transaction.onabort = () => reject(transaction.error ?? new Error("草稿保存被取消"));
      transaction.oncomplete = () => { if (mode === "readwrite" && requestSucceeded) resolve(writtenValue); };
      action(transaction.objectStore("drafts"), (value) => {
        if (mode === "readonly") resolve(value);
        else { writtenValue = value; requestSucceeded = true; }
      }, reject);
    });
  } finally { db.close(); }
}

function queue(key: string, action: () => Promise<void>): Promise<void> {
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  pendingWrites.set(key, next);
  void next.finally(() => { if (pendingWrites.get(key) === next) pendingWrites.delete(key); }).catch(() => undefined);
  return next;
}

export async function readTaskDraft(key: string): Promise<StoredTaskDraft | null> {
  await pendingWrites.get(key)?.catch(() => undefined);
  return transact("readonly", (store, resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as StoredTaskDraft | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("无法读取草稿"));
  });
}

export function saveTaskDraft(key: string, value: StoredTaskDraft): Promise<void> {
  const saved = { ...value, savedAt: Date.now() };
  return queue(key, () => transact("readwrite", (store, resolve, reject) => {
    const request = store.put(saved, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("草稿保存失败"));
  }));
}

export function removeTaskDraft(key: string): Promise<void> {
  return queue(key, () => transact("readwrite", (store, resolve, reject) => {
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("草稿清理失败"));
  }));
}

export async function readRequirementAssistant(key: string): Promise<StoredRequirementAssistant | null> {
  const storageKey = `requirement-assistant:${key}`;
  await pendingWrites.get(storageKey)?.catch(() => undefined);
  return transact("readonly", (store, resolve, reject) => {
    const request = store.get(storageKey);
    request.onsuccess = () => resolve((request.result as StoredRequirementAssistant | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("无法读取需求协作草稿"));
  });
}
export function saveRequirementAssistant(key: string, value: StoredRequirementAssistant): Promise<void> {
  const storageKey = `requirement-assistant:${key}`;
  return queue(storageKey, () => transact("readwrite", (store, resolve, reject) => {
    const request = store.put(value, storageKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("无法保存需求协作草稿"));
  }));
}
export function removeRequirementAssistant(key: string): Promise<void> {
  const storageKey = `requirement-assistant:${key}`;
  return queue(storageKey, () => transact("readwrite", (store, resolve, reject) => {
    const request = store.delete(storageKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("无法移除需求协作草稿"));
  }));
}
