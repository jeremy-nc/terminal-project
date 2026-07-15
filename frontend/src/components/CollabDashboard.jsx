import React, { useState, useEffect, useRef } from "react";
import DocsExplorer from "./DocsExplorer.jsx";
import MarkdownEditor from "./MarkdownEditor.jsx";
import CollabCommandPuck from "./CollabCommandPuck.jsx";  // [collab-command]
import {
  getSelfPresenceId,
  runCollab, collabAddSession, stopCollab, sendAnnotationSelect,
} from "../terminalController.js";
import {
  AgentPanel, annModalState, EMPTY_ARR, closestAnnRoot, offsetInRoot,
} from "./AgentPanel.jsx";

/**
 * Collab workspace panel — launch multiple ACP agent sessions in parallel, chat
 * with them and with other users, and share live "annotations" (text selections)
 * over agent output. One agent per workspace; each panel is a session on it.
 */

const AGENTS = ["stub", "claude-code", "claude-sdk", "gemini", "hermes"];

/** Placeholder shown the instant "+ Add Agent" is clicked — the panel's frame with a
 *  spinner + shimmer — so the UI feels snappy while the agent subprocess spins up. It's
 *  swapped for the real AgentPanel when collab_session_added echoes back its temp id. */
function AgentPanelSkeleton() {
  return (
    <div className="collab-panel skeleton" aria-hidden="true">
      <div className="collab-panel-head">
        <span className="collab-panel-title">Agent</span>
        <span className="sk-spin" />
        {/* button-sized placeholders so the header height matches the real one (Fork/⏹/×) */}
        <span className="collab-skel-btn" style={{ marginLeft: "auto" }} />
        <span className="collab-skel-btn" />
        <span className="collab-skel-btn" />
      </div>
      <div className="collab-feed">
        <div className="text-faint">Starting agent…</div>
        <div className="collab-skel-msg" />
      </div>
      {/* Mirror the real panel's input area (model/mode row · prompt · chat) so swapping
          in the loaded AgentPanel doesn't resize the feed / jolt the layout. */}
      <div className="collab-inputs">
        <div className="collab-skel-row" style={{ width: 150 }} />
        <div className="collab-skel-input" />
        <div className="collab-skel-row" />
      </div>
    </div>
  );
}


export default function CollabDashboard({ workspace }) {
  const w = workspace;
  const collab = w.collab || { active: false, agent: null, sessions: [] };
  const [agent, setAgent] = useState("claude-code");
  const [editingFile, setEditingFile] = useState(null);  // markdown file open in the editor overlay
  const selfId = getSelfPresenceId();

  // Capture THIS window's selection over an agent message and broadcast it as an
  // annotation (throttled live while dragging, final on mouse-up; empty clears).
  useEffect(() => {
    let lastSent = 0, lastKey = null;
    const clearIfAny = () => {
      // Keep this user's highlight visible to others while their "add" annotation
      // modal is open (the modal owns the clear when it closes).
      if (annModalState.addOpen) return;
      if (lastKey) { sendAnnotationSelect(w.id, lastKey.sid, lastKey.seq, 0, 0, false); lastKey = null; }
    };
    const compute = (live) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { clearIfAny(); return; }
      const range = sel.getRangeAt(0);
      const root = closestAnnRoot(range.startContainer);
      if (!root || root !== closestAnnRoot(range.endContainer)) return;
      if (root.dataset.annWid !== w.id) return;
      const sid = root.dataset.annSid, seq = Number(root.dataset.annSeq);
      let start = offsetInRoot(root, range.startContainer, range.startOffset);
      let end = offsetInRoot(root, range.endContainer, range.endOffset);
      if (start > end) [start, end] = [end, start];
      if (start === end) { clearIfAny(); return; }
      lastKey = { sid, seq };
      sendAnnotationSelect(w.id, sid, seq, start, end, live);
    };
    const onSelChange = () => {
      const now = Date.now();
      if (now - lastSent < 50) return;  // ~20Hz throttle for the live stream
      lastSent = now;
      compute(true);
    };
    const onMouseUp = () => compute(false);  // final
    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("mouseup", onMouseUp);
      clearIfAny();
    };
  }, [w.id]);

  // [collab-command] apply a UI navigation intent from the control agent (targeted to
  // me): open a file in the editor, or scroll an agent panel into view + flash it.
  const lastIntent = useRef(0);
  useEffect(() => {
    const ui = w.uiIntent;
    if (!ui || ui.at === lastIntent.current) return;
    lastIntent.current = ui.at;
    if (ui.action === "open_editor" && ui.path) {
      setEditingFile(ui.path);
    } else if (ui.action === "focus_agent" && ui.session_id) {
      const el = document.querySelector(`[data-session-id="${ui.session_id}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
        el.classList.add("collab-flash");
        setTimeout(() => el.classList.remove("collab-flash"), 1200);
        // Put the caret in that panel's prompt so you can start typing to it right away
        // (preventScroll so it doesn't fight the smooth scroll above).
        const input = el.querySelector("textarea.collab-input.agent");
        if (input) input.focus({ preventScroll: true });
      }
    }
  }, [w.uiIntent?.at]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="collab-dash">
      <div className="collab-body">
        <aside className="collab-sidebar">
          <div className="collab-side-head">
            <span className="collab-title">{w.name}</span>
            <span className="collab-dir" title={w.dir}>{w.dir}</span>
          </div>
          {/* Live, read-only file explorer for the workspace's specs/ folder. */}
          <DocsExplorer baseDir={w.dir} subdir="specs" label="Specs" onOpenFile={setEditingFile} />
          <div className="collab-side-actions">
            {!collab.active ? (
              <>
                <label className="collab-agent-label">Agent</label>
                <select className="acp-select" value={agent} onChange={(e) => setAgent(e.target.value)}>
                  {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <button className="collab-run" onClick={() => runCollab(w.id, agent)}>Run Session</button>
              </>
            ) : (
              <>
                <div className="collab-agent-active">Agent: <b>{collab.agent}</b></div>
                <button className="collab-add" onClick={() => collabAddSession(w.id)}>+ Add Agent</button>
                <button className="collab-stop" onClick={() => stopCollab(w.id)}>Stop Session</button>
              </>
            )}
          </div>
        </aside>

        <div className="collab-panels-wrap">
        <div className="collab-panels">
          {!collab.active && <div className="ws-empty">Choose an agent and Run Session to begin.</div>}
          {collab.active && collab.sessions.length === 0 && (w.pendingAgents || []).length === 0 && (
            <div className="ws-empty">Add an agent to open a session.</div>
          )}
          {collab.sessions.map((sid, i) => {
            const delegation = w.delegations?.[sid];
            const parentIndex = delegation?.parent ? collab.sessions.indexOf(delegation.parent) : -1;
            return (
              <AgentPanel
                key={sid}
                index={i}
                workspaceId={w.id}
                sessionId={sid}
                transcript={w.transcriptById?.[sid]}
                perm={w.permById?.[sid]}
                meta={w.acpMetaById?.[sid]}
                annotations={w.annotations}
                draft={w.drafts?.[sid]}
                status={w.statusById?.[sid]}
                selfId={selfId}
                delegation={delegation}
                parentIndex={parentIndex}
                annList={w.annotationsBySession?.[sid] || EMPTY_ARR}
                promptItems={w.promptItemsBySession?.[sid] || EMPTY_ARR}
              />
            );
          })}
          {(w.pendingAgents || []).map((tid) => <AgentPanelSkeleton key={tid} />)}
        </div>
          {/* Editor + puck anchor to the NON-scrolling wrap, so they cover the whole
              visible region even when the panels scroll horizontally underneath. */}
          {editingFile && <MarkdownEditor path={editingFile} workspaceId={w.id}
                                          collabActive={collab.active} onClose={() => setEditingFile(null)} />}
          {/* [collab-command] floating NL command control — only while a session runs. */}
          {collab.active && <CollabCommandPuck workspaceId={w.id} commandStatus={w.commandStatus} />}
        </div>
      </div>
    </div>
  );
}
