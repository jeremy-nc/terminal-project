import React, { useState, useEffect } from "react";
import { createWorkspace, selectWorkspace, clearCloseBlocked, openNewWorkspace, closeNewWorkspace } from "../terminalController.js";
import NewWorkspaceModal from "./NewWorkspaceModal.jsx";
import CloseWorkspaceModal from "./CloseWorkspaceModal.jsx";

/** Tabs for workspaces. Each runs a pipeline independently/concurrently; selecting
 *  one shows its dashboard. "+" opens the create modal; × opens the close dialog.
 *  The create modal's open state lives in the controller (newWorkspace) so a
 *  deep-link / PR action can open it pre-filled too. */
export default function WorkspaceTabBar({ workspaces, activeWorkspaceId, kinds, closeBlocked, newWorkspace }) {
  const [closingId, setClosingId] = useState(null);

  const closing = workspaces.find((w) => w.id === closingId) || null;
  // If the workspace being closed has gone (Remove succeeded), dismiss the dialog.
  useEffect(() => {
    if (closingId && !closing) setClosingId(null);
  }, [closingId, closing]);
  // A blocked removal (dirty worktree) re-opens the dialog so the user can Force.
  useEffect(() => {
    if (closeBlocked) setClosingId(closeBlocked.workspaceId);
  }, [closeBlocked]);

  const startClose = (wid) => { clearCloseBlocked(); setClosingId(wid); };
  const endClose = () => { clearCloseBlocked(); setClosingId(null); };

  return (
    <div className="ws-tabs">
      {workspaces.map((w) => (
        <div
          key={w.id}
          className={`ws-tab${w.id === activeWorkspaceId ? " active" : ""}${w.closing ? " closing" : ""}`}
          onClick={() => selectWorkspace(w.id)}
          title={w.kind === "worktree" ? `worktree · ${w.meta?.branch || w.name}\n${w.dir}` : w.dir}
        >
          {w.closing
            ? <span className="ws-spinner" title="closing…"></span>
            : <span className={`ws-dot status-${w.status || "idle"}`}></span>}
          {w.kind === "worktree" && <span className="ws-kind-badge" title="git worktree">⌥</span>}
          <span className="ws-tab-title">{w.name}</span>
          {w.closing
            ? <span className="ws-closing-label">closing…</span>
            : <button
                className="ws-close"
                onClick={(e) => { e.stopPropagation(); startClose(w.id); }}
                title="Close workspace"
              >×</button>}
        </div>
      ))}
      <button className="ws-new" onClick={() => openNewWorkspace()} title="New workspace">+</button>

      {newWorkspace && (
        <NewWorkspaceModal
          kinds={kinds}
          initial={newWorkspace}
          onClose={closeNewWorkspace}
          onCreate={(kind, fields) => { createWorkspace(kind, fields); closeNewWorkspace(); }}
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
