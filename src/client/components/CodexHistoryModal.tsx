import { useEffect, useMemo, useState } from "react";
import { Clock3, History, Play, RefreshCw, Search, X } from "lucide-react";
import type { CodexConversationSummary, TerminalSession } from "../../shared/types";
import { api } from "../api";

interface Props {
  session: TerminalSession;
  onClose: () => void;
  onResumed: () => void;
}

export function CodexHistoryModal({ session, onClose, onResumed }: Props) {
  const [conversations, setConversations] = useState<CodexConversationSummary[]>([]);
  const [resolvedPath, setResolvedPath] = useState(session.runtime?.currentPath || session.cwd);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.codexConversations(session.id);
      setResolvedPath(result.cwd);
      setConversations(result.conversations);
      setSelectedId((current) =>
        result.conversations.some((item) => item.id === current) ? current : result.conversations[0]?.id || ""
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [session.id]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return conversations;
    }
    return conversations.filter((conversation) =>
      [conversation.title, conversation.summary, conversation.id, conversation.model, conversation.source]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized)
    );
  }, [conversations, query]);

  const selected = conversations.find((conversation) => conversation.id === selectedId);

  const resume = async () => {
    if (!selected || resuming) {
      return;
    }
    setResuming(true);
    setError("");
    try {
      await api.resumeCodexConversation(session.id, selected.id);
      onResumed();
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : String(resumeError));
    } finally {
      setResuming(false);
    }
  };

  return (
    <div className="modal-backdrop codex-history-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-panel codex-history-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Codex 历史对话"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="codex-history-heading">
            <History size={19} />
            <div>
              <h2>Codex 历史对话</h2>
              <span title={resolvedPath}>{resolvedPath}</span>
            </div>
          </div>
          <div className="codex-history-header-actions">
            <button className="icon-button small" type="button" onClick={() => void load()} title="刷新">
              <RefreshCw size={16} className={loading ? "spin" : ""} />
            </button>
            <button className="icon-button small" type="button" onClick={onClose} title="关闭">
              <X size={17} />
            </button>
          </div>
        </header>

        <label className="codex-history-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索摘要或会话 ID" />
        </label>

        <div className="codex-history-list" aria-busy={loading}>
          {!loading && filtered.length === 0 && <div className="codex-history-empty">当前路径没有可恢复的对话</div>}
          {filtered.map((conversation) => (
            <label
              className={conversation.id === selectedId ? "codex-history-item selected" : "codex-history-item"}
              key={conversation.id}
            >
              <input
                type="radio"
                name="codex-conversation"
                value={conversation.id}
                checked={conversation.id === selectedId}
                onChange={() => setSelectedId(conversation.id)}
              />
              <span className="codex-history-content">
                <strong>{conversation.title}</strong>
                <span className="codex-history-summary">{conversation.summary}</span>
                <span className="codex-history-meta">
                  <span>
                    <Clock3 size={13} />
                    {formatConversationTime(conversation.updatedAt)}
                  </span>
                  <code>{conversation.id}</code>
                  {conversation.model && <span>{conversation.model}</span>}
                </span>
              </span>
            </label>
          ))}
        </div>

        {error && <div className="form-error codex-history-error">{error}</div>}

        <footer className="modal-actions codex-history-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="button" disabled={!selected || resuming} onClick={() => void resume()}>
            <Play size={16} />
            {resuming ? "恢复中" : "全权限恢复"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function formatConversationTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
}
