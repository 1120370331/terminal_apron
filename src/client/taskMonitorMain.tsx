import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { TaskMonitorApp } from "./task-monitor/TaskMonitorApp";
import "./task-monitor/taskMonitor.css";

ReactDOM.createRoot(document.getElementById("task-monitor-root")!).render(
  <React.StrictMode>
    <TaskMonitorApp />
  </React.StrictMode>
);
