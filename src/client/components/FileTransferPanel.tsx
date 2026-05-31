import { ChangeEvent, useEffect, useRef, useState } from "react";
import { Clipboard, Download, FolderOpen, RefreshCw, Trash2, Upload, X } from "lucide-react";
import type { FileTransferEntry, FileTransferListResponse } from "../../shared/types";
import { api } from "../api";
import { writeClipboardText } from "../clipboard";

interface Props {
  onClose: () => void;
}

export function FileTransferPanel({ onClose }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [transfer, setTransfer] = useState<FileTransferListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFiles = async () => {
    setLoading(true);
    setError(null);
    try {
      setTransfer(await api.fileTransferList());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFiles();
  }, []);

  const copyText = async (key: string, text: string) => {
    await writeClipboardText(text);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
  };

  const uploadFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0 || uploading) {
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const result = await api.uploadTransferFiles(files);
      setTransfer((current) => ({
        rootPath: result.rootPath,
        terminalText: current?.terminalText ?? "",
        files: mergeUploadedFiles(result.files, current?.files ?? [])
      }));
      await loadFiles();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
    }
  };

  const deleteFile = async (file: FileTransferEntry) => {
    if (!window.confirm(`Delete ${file.name}?`)) {
      return;
    }
    setError(null);
    try {
      await api.deleteTransferFile(file.relativePath);
      await loadFiles();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const files = transfer?.files ?? [];
  const rootPath = transfer?.rootPath ?? "";
  const rootTerminalText = transfer?.terminalText ?? rootPath;

  return (
    <div className="modal-backdrop">
      <section className="modal-panel transfer-panel">
        <header className="modal-header">
          <div className="transfer-heading">
            <FolderOpen size={18} />
            <div>
              <h2>文件传输</h2>
              <span>{files.length} files</span>
            </div>
          </div>
          <button className="icon-button small" type="button" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>

        <div className="transfer-toolbar">
          <button
            className="primary-button"
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={16} />
            {uploading ? "上传中" : "上传文件"}
          </button>
          <button className="secondary-button" type="button" disabled={loading} onClick={() => void loadFiles()}>
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            刷新
          </button>
          <button
            className="secondary-button transfer-copy-root"
            type="button"
            disabled={!rootPath}
            onClick={() => void copyText("root", rootTerminalText)}
          >
            <Clipboard size={16} />
            {copied === "root" ? "已复制" : "复制目录"}
          </button>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => void uploadFiles(event)} />
        </div>

        <div className="transfer-root" title={rootPath}>
          {rootPath || "Loading transfer folder..."}
        </div>

        {error && <div className="form-error transfer-error">{error}</div>}

        <div className="transfer-list" aria-busy={loading || uploading}>
          {loading ? (
            <div className="transfer-empty">Loading files...</div>
          ) : files.length === 0 ? (
            <div className="transfer-empty">No files yet.</div>
          ) : (
            files.map((file) => (
              <article className="transfer-row" key={file.relativePath}>
                <div className="transfer-file-main">
                  <strong title={file.relativePath}>{file.name}</strong>
                  <span>
                    {formatBytes(file.size)} / {formatDate(file.modifiedAt)}
                  </span>
                </div>
                <code title={file.path}>{file.relativePath}</code>
                <div className="transfer-row-actions">
                  <button
                    className="icon-button small"
                    type="button"
                    title={copied === file.relativePath ? "Copied" : "Copy terminal path"}
                    onClick={() => void copyText(file.relativePath, file.terminalText)}
                  >
                    <Clipboard size={15} />
                  </button>
                  <a
                    className="icon-button small"
                    href={api.fileTransferDownloadUrl(file.relativePath)}
                    title="Download"
                  >
                    <Download size={15} />
                  </a>
                  <button
                    className="icon-button small danger"
                    type="button"
                    title="Delete"
                    onClick={() => void deleteFile(file)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function mergeUploadedFiles(uploaded: FileTransferEntry[], current: FileTransferEntry[]): FileTransferEntry[] {
  const byPath = new Map(current.map((file) => [file.relativePath, file]));
  for (const file of uploaded) {
    byPath.set(file.relativePath, file);
  }
  return Array.from(byPath.values()).sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = Math.max(0, value);
  let unitIndex = 0;
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  const digits = next >= 10 || unitIndex === 0 ? 0 : 1;
  return `${next.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}
