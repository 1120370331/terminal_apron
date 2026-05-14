import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { io, type Socket } from "socket.io-client";
import { Clipboard, X } from "lucide-react";
import type { TerminalSession } from "../../shared/types";

interface Props {
  session: TerminalSession;
  onClose: () => void;
}

export function TerminalDock({ session, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [attachCommand, setAttachCommand] = useState<string | null>(null);
  const [backend, setBackend] = useState(session.runtime?.backend ?? session.backend);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      allowProposedApi: true,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.15,
      theme: {
        background: "#111614",
        foreground: "#eef2ed",
        cursor: "#f2c94c",
        selectionBackground: "#2f80ed66"
      },
      scrollback: 50000
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    const socket = io({
      withCredentials: true,
      query: {
        sessionId: session.id,
        cols: terminal.cols,
        rows: terminal.rows
      }
    });

    termRef.current = terminal;
    fitRef.current = fit;
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("connected");
      socket.emit("terminal:resize", { cols: terminal.cols, rows: terminal.rows });
    });
    socket.on("terminal:ready", (payload: { attachCommand: string | null; backend?: string }) => {
      setAttachCommand(payload.attachCommand);
      if (payload.backend) {
        setBackend(payload.backend as "auto" | "native" | "tmux");
      }
    });
    socket.on("terminal:data", (data: string) => {
      terminal.write(data);
    });
    socket.on("terminal:error", (message: string) => {
      setStatus(message);
      terminal.writeln(`\r\n[terminal error] ${message}`);
    });
    socket.on("terminal:exit", () => {
      setStatus("detached");
    });
    socket.on("disconnect", () => {
      setStatus("disconnected");
    });

    const disposable = terminal.onData((data) => {
      socket.emit("terminal:input", data);
    });

    const resize = () => {
      fit.fit();
      socket.emit("terminal:resize", { cols: terminal.cols, rows: terminal.rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    window.setTimeout(resize, 120);

    return () => {
      observer.disconnect();
      disposable.dispose();
      socket.disconnect();
      terminal.dispose();
    };
  }, [session.id]);

  return (
    <div className="terminal-dock">
      <header className="terminal-header">
        <div className="terminal-title">
          <strong>{session.name}</strong>
          <span>{session.runtime?.currentPath || session.cwd}</span>
        </div>
        <div className="terminal-actions">
          {attachCommand ? (
            <>
              <code>{attachCommand}</code>
              <button
                className="icon-button"
                type="button"
                title="复制本机 attach 命令"
                onClick={() => void navigator.clipboard.writeText(attachCommand)}
              >
                <Clipboard size={17} />
              </button>
            </>
          ) : (
            <code>{backend} pty</code>
          )}
          <span className="terminal-status">{status}</span>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
