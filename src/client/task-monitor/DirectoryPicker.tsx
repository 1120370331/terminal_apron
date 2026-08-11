import {
  ArrowUp,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  LoaderCircle,
  Monitor,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DirectoryBrowserResult, FilesystemLocationKind } from "../../shared/types";
import { taskApi } from "../taskApi";

interface Props {
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

const LOCATION_ICONS: Record<FilesystemLocationKind, typeof Home> = {
  home: Home,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  drive: HardDrive
};

export function DirectoryPicker({ initialPath, onClose, onSelect }: Props) {
  const [browser, setBrowser] = useState<DirectoryBrowserResult | null>(null);
  const [address, setAddress] = useState(initialPath);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);

  const loadDirectory = async (nextPath?: string) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await taskApi.browseDirectory(nextPath, controller.signal);
      setBrowser(result);
      setAddress(result.path);
      setQuery("");
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setError(loadError instanceof Error ? loadError.message : "目录读取失败");
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadDirectory(initialPath || undefined);
    return () => requestRef.current?.abort();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filteredDirectories = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return (browser?.directories ?? []).filter((directory) =>
      normalized ? directory.name.toLocaleLowerCase("zh-CN").includes(normalized) : true
    );
  }, [browser?.directories, query]);

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    void loadDirectory(address);
  };

  return (
    <div
      className="task-directory-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section
        className="task-directory-panel"
        role="dialog"
        aria-modal="true"
        aria-label="选择项目根目录"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="task-directory-header">
          <div>
            <FolderOpen size={20} />
            <span>
              <strong>选择项目根目录</strong>
              <small>Codex 将以这个文件夹作为任务代码库</small>
            </span>
          </div>
          <button className="task-icon-button" type="button" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>

        <form className="task-directory-address" onSubmit={submitAddress}>
          <button
            className="task-icon-button"
            type="button"
            disabled={!browser?.parentPath || loading}
            onClick={() => void loadDirectory(browser?.parentPath || undefined)}
            title="上一级"
          >
            <ArrowUp size={16} />
          </button>
          <label>
            <Folder size={15} />
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              aria-label="文件夹路径"
              spellCheck={false}
            />
          </label>
          <button
            className="task-icon-button"
            type="button"
            disabled={!browser || loading}
            onClick={() => void loadDirectory(browser?.path)}
            title="刷新"
          >
            <RefreshCw className={loading ? "spin" : ""} size={16} />
          </button>
        </form>

        <div className="task-directory-body">
          <nav className="task-directory-locations" aria-label="常用位置">
            <span>常用位置</span>
            {browser?.locations.map((location) => {
              const Icon = LOCATION_ICONS[location.kind];
              return (
                <button
                  className={location.path === browser.path ? "active" : ""}
                  type="button"
                  key={`${location.kind}:${location.path}`}
                  onClick={() => void loadDirectory(location.path)}
                  title={location.path}
                >
                  <Icon size={16} />
                  <span>{location.label}</span>
                </button>
              );
            })}
          </nav>

          <main className="task-directory-content">
            <div className="task-directory-toolbar">
              <div className="task-directory-breadcrumbs" aria-label="当前路径">
                {browser &&
                  pathBreadcrumbs(browser.path).map((part, index) => (
                    <span key={part.path}>
                      {index > 0 && <ChevronRight size={13} />}
                      <button type="button" onClick={() => void loadDirectory(part.path)} title={part.path}>
                        {part.label}
                      </button>
                    </span>
                  ))}
              </div>
              <label className="task-directory-search">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="筛选文件夹"
                  aria-label="筛选文件夹"
                />
              </label>
            </div>

            <div className="task-directory-list" aria-busy={loading}>
              {loading && (
                <div className="task-directory-message">
                  <LoaderCircle className="spin" size={21} />
                  <span>正在读取目录</span>
                </div>
              )}
              {!loading && error && <div className="task-directory-message error">{error}</div>}
              {!loading && !error && filteredDirectories.length === 0 && (
                <div className="task-directory-message">这里没有可显示的文件夹</div>
              )}
              {!loading &&
                !error &&
                filteredDirectories.map((directory) => (
                  <button
                    className="task-directory-item"
                    type="button"
                    key={directory.path}
                    onClick={() => void loadDirectory(directory.path)}
                    title={directory.path}
                  >
                    <Folder size={18} />
                    <span>{directory.name}</span>
                    <ChevronRight size={15} />
                  </button>
                ))}
            </div>
          </main>
        </div>

        <footer className="task-directory-footer">
          <code title={browser?.path}>{browser?.path || "正在读取目录…"}</code>
          <div>
            <button className="task-secondary-button" type="button" onClick={onClose}>
              取消
            </button>
            <button
              className="task-primary-button"
              type="button"
              disabled={!browser || loading || Boolean(error)}
              onClick={() => browser && onSelect(browser.path)}
            >
              <FolderOpen size={16} />
              选择此文件夹
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function pathBreadcrumbs(value: string): Array<{ label: string; path: string }> {
  const windowsMatch = /^([a-zA-Z]:)[\\/]*(.*)$/.exec(value);
  if (windowsMatch) {
    const root = `${windowsMatch[1]}\\`;
    const parts = windowsMatch[2].split(/[\\/]+/).filter(Boolean);
    let current = root;
    return [
      { label: windowsMatch[1], path: root },
      ...parts.map((part) => {
        current = `${current.replace(/[\\/]$/, "")}\\${part}`;
        return { label: part, path: current };
      })
    ];
  }
  if (value.startsWith("/")) {
    let current = "";
    return [
      { label: "/", path: "/" },
      ...value
        .split("/")
        .filter(Boolean)
        .map((part) => {
          current += `/${part}`;
          return { label: part, path: current };
        })
    ];
  }
  return [{ label: value, path: value }];
}
