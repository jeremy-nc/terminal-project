import React from "react";
import { createWorkspace, deleteWorkspace, selectWorkspace } from "../terminalController.js";

/** Tabs for pipeline sessions (workspaces). Each runs independently/concurrently;
 *  selecting one shows its dashboard. "+" creates one (prompting for a dir). */
export default function WorkspaceTabBar({ workspaces, activeWorkspaceId }) {
  const onNew = () => {
    const dir = window.prompt("Working directory for the new session:", "~/Code/terminal-project");
    if (dir && dir.trim()) createWorkspace(dir.trim());
  };

  return (
    <div className="ws-tabs">
      {workspaces.map((w) => (
        <div
          key={w.id}
          className={`ws-tab${w.id === activeWorkspaceId ? " active" : ""}`}
          onClick={() => selectWorkspace(w.id)}
          title={w.dir}
        >
          <span className={`ws-dot status-${w.status || "idle"}`}></span>
          <span className="ws-tab-title">{w.name}</span>
          <button
            className="ws-close"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Delete session "${w.name}"?`)) deleteWorkspace(w.id);
            }}
            title="Delete session"
          >×</button>
        </div>
      ))}
      <button className="ws-new" onClick={onNew} title="New session">+</button>
    </div>
  );
}
