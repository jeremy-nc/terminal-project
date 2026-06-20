import React, { useEffect } from "react";
import { deleteWorkspace } from "../terminalController.js";

/** Close/delete dialog for a workspace. For a worktree it offers Remove vs Keep,
 *  and — if git refused a dirty tree (blocked) — a Force option. For a plain
 *  directory it's a simple confirm. The parent closes this once the workspace is
 *  gone (Remove succeeded) or the user cancels. */
export default function CloseWorkspaceModal({ workspace, blockedMessage, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isWorktree = workspace.kind === "worktree";
  const branch = workspace.meta?.branch || workspace.name;

  // Every choice dismisses the dialog immediately; the tab then shows "closing…"
  // while the backend tears down. A blocked Remove re-opens this dialog (via the
  // parent) with a Force option.
  const keep = () => { deleteWorkspace(workspace.id); onClose(); };
  const remove = () => { deleteWorkspace(workspace.id, { remove_resources: true }); onClose(); };
  const force = () => { deleteWorkspace(workspace.id, { remove_resources: true, force: true }); onClose(); };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Close “{workspace.name}”</div>

        {isWorktree ? (
          <>
            <div className="modal-body">
              This is a git worktree on branch <code>{branch}</code>. Removing it deletes the
              checkout at <code>{workspace.dir}</code> — the branch and its commits are kept.
            </div>
            {blockedMessage && (
              <div className="modal-warn">{blockedMessage}</div>
            )}
            <div className="modal-actions">
              <button className="modal-cancel" onClick={onClose}>Cancel</button>
              <button className="modal-keep" onClick={keep}>Keep worktree</button>
              {blockedMessage
                ? <button className="modal-danger" onClick={force}>Force remove</button>
                : <button className="modal-danger" onClick={remove}>Remove worktree</button>}
            </div>
          </>
        ) : (
          <>
            <div className="modal-body">Delete this workspace? Its directory is left untouched.</div>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={onClose}>Cancel</button>
              <button className="modal-danger" onClick={keep}>Delete</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
