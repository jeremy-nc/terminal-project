import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import MDEditor from "@uiw/react-md-editor";
import {
  readFile, writeFile, subscribe, getSnapshot, getSelfPresenceId,
  openEditorAgent, editorAgentPrompt,
} from "../terminalController.js";
import { AgentPanel } from "./AgentPanel.jsx";

// The editor agent is a normal — but SHARED — workspace session: everyone editing the
// same file talks to the same agent (same transcript + collaborative prompt). It just
// renders here in the modal instead of as a Collab panel, via the same <AgentChat>-style
// AgentPanel with the Collab-only chrome (fork/delegation/model/annotations) turned off.
// The editor uses the same generic layout as Collab, keeping the standard bits —
// human chat and the model/mode selectors — and only drops the panel chrome
// (header/fork), delegation, and the review annotations.
const EDITOR_FEATURES = { header: false, fork: false, delegation: false, annotations: false };

/** Markdown editor overlay + a dedicated agent (right) that edits THIS file. Sending
 *  saves the current text first (so the agent sees your latest), the agent edits the
 *  file, then we reload on its next idle so the change shows live. The agent is shared
 *  per file and lives for the Collab session (reopening the file resumes it). */
export default function MarkdownEditor({ path, workspaceId, collabActive, onClose }) {
  const [content, setContent] = useState(null);   // null = loading
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [agentSid, setAgentSid] = useState(null);
  const contentRef = useRef("");
  contentRef.current = content ?? "";
  const selfId = getSelfPresenceId();

  const state = useSyncExternalStore(subscribe, getSnapshot);
  const ws = state.workspaces?.find((x) => x.id === workspaceId);
  const transcript = agentSid ? ws?.transcriptById?.[agentSid] : null;
  const agentStatus = agentSid ? ws?.statusById?.[agentSid] : null;
  const draft = agentSid ? ws?.drafts?.[agentSid] : undefined;
  const meta = agentSid ? ws?.acpMetaById?.[agentSid] : undefined;
  const perm = agentSid ? ws?.permById?.[agentSid] : undefined;

  // Load the file.
  useEffect(() => {
    let alive = true;
    setContent(null); setDirty(false); setError(null);
    readFile(path).then((c) => alive && setContent(c)).catch((e) => alive && setError(String(e.message || e)));
    return () => { alive = false; };
  }, [path]);

  // Attach to the file's shared agent — only with an active Collab session. We do NOT
  // tear it down on close: it's a shared workspace session that persists until the
  // Collab session stops (closing here just stops rendering it).
  useEffect(() => {
    if (!collabActive) return undefined;
    let alive = true;
    openEditorAgent(workspaceId, path).then((s) => { if (alive && s) setAgentSid(s); }).catch(() => {});
    return () => { alive = false; setAgentSid(null); };
  }, [path, workspaceId, collabActive]);

  // When the agent finishes a turn (running -> idle), reload the file (it may have edited it).
  const prevStatus = useRef(null);
  useEffect(() => {
    if (prevStatus.current === "running" && agentStatus === "idle") {
      readFile(path).then((c) => { setContent(c); setDirty(false); }).catch(() => {});
    }
    prevStatus.current = agentStatus;
  }, [agentStatus, path]);

  const save = async () => {
    setSaving(true); setError(null);
    try { await writeFile(path, contentRef.current); setDirty(false); }
    catch (e) { setError(String(e.message || e)); }
    finally { setSaving(false); }
  };
  // AgentPanel's send calls this (after clearing the shared draft): save the current
  // editor text so the agent reads your latest, then prompt.
  const onAgentSend = async (t) => {
    try { await writeFile(path, contentRef.current); setDirty(false); } catch (_) { /* keep going */ }
    if (agentSid) editorAgentPrompt(workspaceId, agentSid, t);
  };
  const close = () => { if (dirty && !window.confirm("Discard unsaved changes?")) return; onClose(); };

  const name = (path || "").split("/").pop();
  const thinking = agentStatus === "running";
  return (
    <div className="md-editor-overlay">
      <div className="md-editor-head">
        <span className="md-editor-name">📝 {name}{dirty ? " ●" : ""}</span>
        <button className="md-editor-save" onClick={save} disabled={!dirty || saving || content == null}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="md-editor-close" title="Close" onClick={close}>×</button>
      </div>
      <div className="md-editor-split">
        <div className="md-editor-pane" data-color-mode="dark">
          {error ? (
            <div className="md-editor-msg err">⚠ {error}</div>
          ) : content == null ? (
            <div className="md-editor-msg">Loading…</div>
          ) : (
            <MDEditor value={content} height="100%" preview="live" visibleDragbar={false}
                      onChange={(v) => { setContent(v ?? ""); setDirty(true); }} />
          )}
        </div>
        <div className="md-agent">
          <div className="md-agent-head">🤖 Edit with agent{thinking ? " · thinking…" : ""}</div>
          {!collabActive ? (
            <div className="md-agent-empty">Run a Collab session to chat with an agent about this file.</div>
          ) : !agentSid ? (
            <div className="md-agent-empty">Connecting to this file's agent…</div>
          ) : (
            <AgentPanel
              className="md-agent-panel"
              workspaceId={workspaceId}
              sessionId={agentSid}
              transcript={transcript}
              status={agentStatus}
              draft={draft}
              meta={meta}
              perm={perm}
              selfId={selfId}
              index={0}
              features={EDITOR_FEATURES}
              onSend={onAgentSend}
              placeholder="Ask to edit this file — shared, ⌘⏎ to send…"
              emptyHint='Ask the agent to change this file — e.g. "tighten the intro".'
            />
          )}
        </div>
      </div>
    </div>
  );
}
