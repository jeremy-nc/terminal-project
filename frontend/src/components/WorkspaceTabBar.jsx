import React, { useState, useEffect, useMemo, useRef } from "react";
import { createWorkspace, selectWorkspace, clearCloseBlocked, openNewWorkspace, closeNewWorkspace, setWorkspaceOrder } from "../terminalController.js";
import NewWorkspaceModal from "./NewWorkspaceModal.jsx";
import CloseWorkspaceModal from "./CloseWorkspaceModal.jsx";

/** Tabs for workspaces. Each runs a pipeline independently/concurrently; selecting
 *  one shows its dashboard. "+" opens the create modal; × opens the close dialog.
 *  Tabs render in the decoupled `order` (drag a tab to reorder; persisted server-
 *  side). The create modal's open state lives in the controller (newWorkspace) so
 *  a deep-link / PR action can open it pre-filled too. */
export default function WorkspaceTabBar({ workspaces, order = [], activeWorkspaceId, kinds, closeBlocked, newWorkspace, repos }) {
  const [closingId, setClosingId] = useState(null);
  const [dragId, setDragId] = useState(null);     // workspace id being dragged
  const [overId, setOverId] = useState(null);     // tab currently hovered as drop target
  const tabsRef = useRef(null);

  // When the active workspace changes (e.g. a portal jump), if its tab is scrolled
  // off-screen, scroll the bar so it sits against the left edge.
  useEffect(() => {
    const c = tabsRef.current;
    const el = c && c.querySelector(".ws-tab.active");
    if (!el) return;
    const cRect = c.getBoundingClientRect(), eRect = el.getBoundingClientRect();
    if (eRect.left < cRect.left || eRect.right > cRect.right) {
      const padLeft = parseFloat(getComputedStyle(c).paddingLeft) || 0;
      c.scrollTo({ left: c.scrollLeft + (eRect.left - cRect.left - padLeft), behavior: "smooth" });
    }
  }, [activeWorkspaceId]);

  // Render in the server's reconciled order, falling back to append for any id
  // not yet in the order (race-safe).
  const ordered = useMemo(() => {
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const seen = new Set();
    const out = [];
    for (const id of order) { const w = byId.get(id); if (w && !seen.has(id)) { out.push(w); seen.add(id); } }
    for (const w of workspaces) if (!seen.has(w.id)) out.push(w);
    return out;
  }, [workspaces, order]);

  const onDrop = (targetId) => {
    setOverId(null);
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ids = ordered.map((w) => w.id);
    const from = ids.indexOf(dragId);
    ids.splice(from, 1);
    ids.splice(ids.indexOf(targetId), 0, dragId);   // drop before the target
    setDragId(null);
    setWorkspaceOrder(ids);
  };

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
    <div className="ws-tabs" ref={tabsRef}>
      {ordered.map((w) => (
        <div
          key={w.id}
          className={`ws-tab${w.id === activeWorkspaceId ? " active" : ""}${w.closing ? " closing" : ""}${w.id === dragId ? " dragging" : ""}${w.id === overId && dragId && w.id !== dragId ? " drag-over" : ""}`}
          onClick={() => selectWorkspace(w.id)}
          title={w.kind === "worktree" ? `worktree · ${w.meta?.branch || w.name}\n${w.dir}` : w.dir}
          draggable={!w.closing}
          onDragStart={(e) => { setDragId(w.id); e.dataTransfer.effectAllowed = "move"; }}
          onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(w.id); } }}
          onDragLeave={() => setOverId((id) => (id === w.id ? null : id))}
          onDrop={(e) => { e.preventDefault(); onDrop(w.id); }}
          onDragEnd={() => { setDragId(null); setOverId(null); }}
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
          repos={repos}
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
