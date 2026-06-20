import React, { useState, useEffect } from "react";
import { createWorkspace, selectWorkspace, clearCloseBlocked } from "../terminalController.js";
import NewWorkspaceModal from "./NewWorkspaceModal.jsx";
import CloseWorkspaceModal from "./CloseWorkspaceModal.jsx";

/** Tabs for workspaces. Each runs a pipeline independently/concurrently; selecting
 *  one shows its dashboard. "+" opens the create modal; × opens the close dialog. */
export default function WorkspaceTabBar({ workspaces, activeWorkspaceId, kinds, closeBlocked }) {
  const [creating, setCreating] = useState(false);
  const [closingId, setClosingId] = useState(null);

  const closing = workspaces.find((w) => w.id === closingId) || null;
  // If the workspace being closed has gone (Remove succeeded), dismiss the dialog.
  useEffect(() => {
    if (closingId && !closing) setClosingId(null);
  }, [closingId, closing]);

  const startClose = (wid) => { clearCloseBlocked(); setClosingId(wid); };
  const endClose = () => { clearCloseBlocked(); setClosingId(null); };

  return (
    <div className="ws-tabs">
      {workspaces.map((w) => (
        <div
          key={w.id}
          className={`ws-tab${w.id === activeWorkspaceId ? " active" : ""}`}
          onClick={() => selectWorkspace(w.id)}
          title={w.kind === "worktree" ? `worktree · ${w.meta?.branch || w.name}\n${w.dir}` : w.dir}
        >
          <span className={`ws-dot status-${w.status || "idle"}`}></span>
          {w.kind === "worktree" && <span className="ws-kind-badge" title="git worktree">⌥</span>}
          <span className="ws-tab-title">{w.name}</span>
          <button
            className="ws-close"
            onClick={(e) => { e.stopPropagation(); startClose(w.id); }}
            title="Close workspace"
          >×</button>
        </div>
      ))}
      <button className="ws-new" onClick={() => setCreating(true)} title="New workspace">+</button>

      {creating && (
        <NewWorkspaceModal
          kinds={kinds}
          onClose={() => setCreating(false)}
          onCreate={(kind, fields) => { createWorkspace(kind, fields); setCreating(false); }}
        />
      )}

      {closing && (
        <CloseWorkspaceModal
          workspace={closing}
          blockedMessage={closeBlocked?.workspaceId === closing.id ? closeBlocked.message : null}
          onClose={endClose}
        />
      )}
    </div>
  );
}
