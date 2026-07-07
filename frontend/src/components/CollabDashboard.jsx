import React, { useRef, useLayoutEffect, useState, useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getSelfPresenceId,
  runCollab, collabAddSession, collabForkSession, collabPrompt, collabChat,
  collabCancel, collabRemoveSession, stopCollab, sendAnnotationSelect, sendPromptTyping, updateDraftLocal,
  setAcpMode, setAcpModel, replyAcpPermission,
} from "../terminalController.js";

// Pixel position of a caret index inside a textarea, via a hidden mirror div
// (standard technique — you can't read caret coords from a textarea directly).
function caretCoords(ta, index) {
  const div = document.createElement("div");
  const s = getComputedStyle(ta);
  for (const p of ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
                   "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
                   "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign"]) {
    div.style[p] = s[p];
  }
  div.style.position = "absolute"; div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap"; div.style.wordWrap = "break-word";
  div.textContent = ta.value.slice(0, index);
  const span = document.createElement("span");
  span.textContent = ta.value.slice(index) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const x = span.offsetLeft, y = span.offsetTop;
  document.body.removeChild(div);
  return { x, y };
}

/** Overlay: other users' carets inside the shared prompt textarea, with ID chips.
 *  Carets scrolled out of the visible area are hidden (not drawn over neighbours). */
function DraftCursors({ taRef, draft, selfId, tick }) {
  const [marks, setMarks] = useState([]);
  const cursors = draft.cursors || {};
  const sig = JSON.stringify(cursors) + "|" + (draft.text || "").length;
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) { setMarks([]); return; }
    const out = [];
    for (const [user, pos] of Object.entries(cursors)) {
      if (user === selfId) continue;
      const { x, y } = caretCoords(ta, Math.max(0, Math.min(pos, ta.value.length)));
      const top = y - ta.scrollTop, left = x - ta.scrollLeft;
      if (top < 0 || top > ta.clientHeight) continue;  // caret scrolled out of view
      out.push({ user, color: colorForId(user), left, top });
    }
    setMarks(out);
  }, [sig, tick]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="collab-cursors">
      {marks.map((m) => (
        <div key={m.user} className="collab-cursor" style={{ left: m.left, top: m.top }}>
          <span className="collab-cursor-bar" style={{ background: m.color }} />
          <span className="collab-cursor-id" style={{ background: m.color }}>{short(m.user)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Collab workspace panel — launch multiple ACP agent sessions in parallel, chat
 * with them and with other users, and share live "annotations" (text selections)
 * over agent output. One agent per workspace; each panel is a session on it.
 */

const AGENTS = ["stub", "claude-code", "gemini", "hermes"];

// ── annotations: per-user colour + char-offset ↔ DOM Range helpers ────────────
function colorForId(id) {
  let h = 0;
  for (let i = 0; i < (id || "").length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 80%, 60%)`;
}
function offsetInRoot(root, node, nodeOffset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0, n;
  while ((n = walker.nextNode())) {
    if (n === node) return offset + nodeOffset;
    offset += n.textContent.length;
  }
  return offset + nodeOffset;
}
function rangeFromOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0, sn, so, en, eo, n;
  while ((n = walker.nextNode())) {
    const len = n.textContent.length;
    if (sn == null && offset + len >= start) { sn = n; so = start - offset; }
    if (offset + len >= end) { en = n; eo = end - offset; break; }
    offset += len;
  }
  if (!sn || !en) return null;
  try { const r = document.createRange(); r.setStart(sn, so); r.setEnd(en, eo); return r; }
  catch (_) { return null; }
}
function closestAnnRoot(node) {
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  return el && el.closest ? el.closest(".collab-msg[data-ann-seq]") : null;
}

function short(id) { return (id || "").slice(0, 6); }

// Friendly labels for the agent's actions (ACP tool "kind") shown in the chat.
const TOOL_VERB = {
  search: "🔍 Find", execute: "⚡ Run", read: "📄 Read", edit: "✏️ Edit",
  delete: "🗑 Delete", move: "📦 Move", fetch: "🌐 Fetch (web)", think: "💭 Thinking",
  switch_mode: "🔀 Switch mode", other: "⚙ Working",
};

function useStick(dep) {
  const ref = useRef(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return { ref, onScroll };
}

/** Overlay layer: draws translucent coloured boxes for OTHER users' annotation
 *  selections over this panel's agent messages. Recomputed on content/resize. */
function AnnotationOverlay({ feedRef, annotations, sessionId, selfId, tick }) {
  const [boxes, setBoxes] = useState([]);
  const relevant = Object.entries(annotations || {})
    .filter(([user, a]) => a.sessionId === sessionId && user !== selfId);
  const sig = JSON.stringify(relevant);
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed) { setBoxes([]); return; }
    const fr = feed.getBoundingClientRect();
    const out = [];
    for (const [user, a] of relevant) {
      const root = feed.querySelector(`.collab-msg[data-ann-seq="${a.seq}"][data-ann-sid="${sessionId}"]`);
      if (!root) continue;
      const range = rangeFromOffsets(root, a.start, a.end);
      if (!range) continue;
      const color = colorForId(user);
      let i = 0;
      for (const rc of range.getClientRects()) {
        out.push({ key: `${user}-${i++}`, color, live: a.live,
                   left: rc.left - fr.left, top: rc.top - fr.top + feed.scrollTop,
                   width: rc.width, height: rc.height });
      }
    }
    setBoxes(out);
  }, [sig, tick]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="collab-annlayer">
      {boxes.map((b) => (
        <div key={b.key} className={`collab-ann${b.live ? " live" : ""}`}
             style={{ left: b.left, top: b.top, width: b.width, height: b.height,
                      background: b.color, borderColor: b.color }} />
      ))}
    </div>
  );
}

function Bubble({ e, selfId, workspaceId, sessionId }) {
  const mine = (e.kind === "user" || e.kind === "chat") && e.sender === selfId;
  const side = mine ? "left" : "right";

  if (e.kind === "chat") {
    return (
      <div className={`collab-bubble ${side} chat`}>
        {!mine && <div className="collab-sender">{short(e.sender)}</div>}
        <div className="collab-bubble-text">{e.text}</div>
      </div>
    );
  }
  if (e.kind === "user") {
    return (
      <div className={`collab-bubble ${side} prompt`}>
        {!mine && <div className="collab-sender">{short(e.sender)} → agent</div>}
        <div className="collab-bubble-text">{e.text}</div>
      </div>
    );
  }
  if (e.kind === "message") {
    return (
      <div className="collab-bubble right agent">
        <div className="collab-msg" data-ann-wid={workspaceId} data-ann-sid={sessionId} data-ann-seq={e.seq}>
          <Markdown remarkPlugins={[remarkGfm]}>{e.text || ""}</Markdown>
        </div>
      </div>
    );
  }
  if (e.kind === "thought") return <div className="collab-thought">{e.text}</div>;
  if (e.kind === "tool_call") {
    // The agent's reasoning comes through as a "think" tool — render it subtly.
    if (e.tool === "think") return <div className="collab-thought">{e.output || e.title}</div>;
    const verb = TOOL_VERB[e.tool] || (e.tool ? `⚙ ${e.tool}` : "⚙ Working");
    return (
      <div className={`collab-bubble right tool status-${e.status || "pending"}`}>
        <div className="collab-tool-head">
          <span className="collab-tool-dot" />
          <span className="collab-tool-verb">{verb}</span>
          {e.title && <span className="collab-tool-title">{e.title}</span>}
        </div>
        {e.output && <pre className="collab-tool-out">{e.output}</pre>}
      </div>
    );
  }
  if (e.kind === "diff") {
    return <div className="collab-bubble right"><div className="acp-diff-path">{e.path}</div><pre>{e.newText}</pre></div>;
  }
  if (e.kind === "error") return <div className="acp-error">⚠ {e.text}</div>;
  return null;
}

function AgentPanel({ workspaceId, sessionId, transcript, perm, meta, annotations, drafts, status, selfId, index }) {
  const [chatText, setChatText] = useState("");
  const [tick, setTick] = useState(0);
  const typedAt = useRef(0);
  const taRef = useRef(null);
  const lastLocal = useRef(false);
  const prevCaret = useRef(0);
  const entries = transcript?.entries || [];
  const feed = useStick(transcript);
  const models = meta?.models, modes = meta?.modes;
  const draft = drafts?.[sessionId] || { text: "", cursors: {} };
  const thinking = status === "running";

  // Slash-command menu over the shared prompt: shown when the draft starts with "/".
  const commands = meta?.commands || [];
  const slashFilter = (draft.text || "").startsWith("/") ? draft.text.slice(1).toLowerCase().split(/\s/)[0] : null;
  const shownCmds = slashFilter != null ? commands.filter((c) => (c.name || "").toLowerCase().includes(slashFilter)) : [];
  const pickCmd = (name) => {
    const t = `/${name} `;
    updateDraftLocal(workspaceId, sessionId, t, t.length, selfId);
    broadcastTyping(t, t.length, true);
    taRef.current?.focus();
  };

  // Shared prompt draft: everyone edits the same text (last-writer-wins). Optimistic
  // local update for instant echo, throttled broadcast for others.
  const broadcastTyping = (text, cursor, force) => {
    const now = Date.now();
    if (!force && now - typedAt.current < 70) return;
    typedAt.current = now;
    sendPromptTyping(workspaceId, sessionId, text, cursor);
  };
  const onDraftChange = (e) => {
    lastLocal.current = true; prevCaret.current = e.target.selectionStart;
    updateDraftLocal(workspaceId, sessionId, e.target.value, e.target.selectionStart, selfId);
    broadcastTyping(e.target.value, e.target.selectionStart);
  };
  const onDraftCaret = (e) => { prevCaret.current = e.target.selectionStart; broadcastTyping(e.target.value, e.target.selectionStart); };
  // A remote edit re-set the textarea value; keep the local caret sensible.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (lastLocal.current) { lastLocal.current = false; return; }
    const pos = Math.min(prevCaret.current, draft.text.length);
    try { ta.setSelectionRange(pos, pos); } catch (_) {}
  }, [draft.text]);

  // Recompute annotation overlays on layout changes (window resize, streaming growth).
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
  }, []);
  useEffect(() => { setTick((t) => t + 1); }, [entries.length]);

  const sendAgent = () => {
    const t = (draft.text || "").trim();
    if (t) {
      collabPrompt(workspaceId, sessionId, t);
      updateDraftLocal(workspaceId, sessionId, "", 0, selfId);
      broadcastTyping("", 0, true);
    }
  };
  const sendChat = () => {
    const t = chatText.trim();
    if (t) { collabChat(workspaceId, sessionId, t); setChatText(""); }
  };

  return (
    <div className="collab-panel">
      <div className="collab-panel-head">
        <span className="collab-panel-title">Agent {index + 1}</span>
        <span className="collab-panel-sid" title={sessionId}>{short(sessionId)}</span>
        <button className="collab-fork" title="Fork this session into a new panel"
                onClick={() => collabForkSession(workspaceId, sessionId, null)}>⑂ Fork</button>
        <button className="collab-panel-btn" title="Interrupt the current turn"
                onClick={() => collabCancel(workspaceId, sessionId)}>⏹</button>
        <button className="collab-panel-btn close" title="Close this panel"
                onClick={() => collabRemoveSession(workspaceId, sessionId)}>×</button>
      </div>

      <div className="collab-feed" ref={feed.ref} onScroll={feed.onScroll}>
        {entries.length === 0 && <div className="text-faint">No messages yet.</div>}
        {entries.map((e) => <Bubble key={e.seq} e={e} selfId={selfId} workspaceId={workspaceId} sessionId={sessionId} />)}
        {perm && (
          <div className="acp-perm">
            <div className="acp-perm-head">⚠ {perm.title}</div>
            {perm.content && <pre className="acp-perm-content">{perm.content}</pre>}
            <div className="acp-perm-actions">
              {(perm.options || []).map((o) => (
                <button key={o.id} className={`acp-perm-btn kind-${o.kind || "reject"}`}
                        onClick={() => replyAcpPermission(workspaceId, sessionId, perm.requestId, o.id)}>{o.name}</button>
              ))}
            </div>
          </div>
        )}
        <AnnotationOverlay feedRef={feed.ref} annotations={annotations} sessionId={sessionId} selfId={selfId} tick={tick} />
      </div>

      <div className="collab-inputs">
        {thinking && (
          <div className="acp-working"><span className="acp-dots"><i></i><i></i><i></i></span>Thinking…</div>
        )}
        {(models?.availableModels?.length || modes?.availableModes?.length) ? (
          <div className="acp-controls">
            {models?.availableModels?.length > 0 && (
              <select className="acp-select" value={models.currentModelId || ""}
                      onChange={(ev) => setAcpModel(workspaceId, sessionId, ev.target.value)}>
                {models.availableModels.map((m) => <option key={m.modelId} value={m.modelId}>{m.name}</option>)}
              </select>
            )}
            {modes?.availableModes?.length > 0 && (
              <select className="acp-select" value={modes.currentModeId || ""}
                      onChange={(ev) => setAcpMode(workspaceId, sessionId, ev.target.value)}>
                {modes.availableModes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
          </div>
        ) : null}
        <div className="collab-input-row">
          <div className="collab-textwrap">
            {slashFilter != null && shownCmds.length > 0 && (
              <div className="acp-cmd-menu">
                {shownCmds.slice(0, 60).map((c) => (
                  <div key={c.name} className="acp-cmd-item" onClick={() => pickCmd(c.name)}>
                    <span className="acp-cmd-name">/{c.name}</span>
                    {c.description && <span className="acp-cmd-desc">{c.description}</span>}
                  </div>
                ))}
              </div>
            )}
            <textarea ref={taRef} className="collab-input agent" rows={3}
                      placeholder="Prompt the agent — shared, ⌘⏎ to send…"
                      value={draft.text}
                      onChange={onDraftChange} onSelect={onDraftCaret} onScroll={() => setTick((t) => t + 1)}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAgent(); } }} />
            <DraftCursors taRef={taRef} draft={draft} selfId={selfId} tick={tick} />
          </div>
          <button className="collab-send agent" onClick={sendAgent} disabled={!(draft.text || "").trim()}>Send</button>
        </div>
        <div className="collab-input-row">
          <input className="collab-input" placeholder="Chat (not sent to agent)…" value={chatText}
                 onChange={(e) => setChatText(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }} />
          <button className="collab-send" onClick={sendChat} disabled={!chatText.trim()}>Send</button>
        </div>
      </div>
    </div>
  );
}

export default function CollabDashboard({ workspace }) {
  const w = workspace;
  const collab = w.collab || { active: false, agent: null, sessions: [] };
  const [agent, setAgent] = useState("claude-code");
  const selfId = getSelfPresenceId();

  // Capture THIS window's selection over an agent message and broadcast it as an
  // annotation (throttled live while dragging, final on mouse-up; empty clears).
  useEffect(() => {
    let lastSent = 0, lastKey = null;
    const clearIfAny = () => {
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

  return (
    <div className="collab-dash">
      <div className="collab-body">
        <aside className="collab-sidebar">
          <div className="collab-side-head">
            <span className="collab-title">{w.name}</span>
            <span className="collab-dir" title={w.dir}>{w.dir}</span>
          </div>
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

        <div className="collab-panels">
          {!collab.active && <div className="ws-empty">Choose an agent and Run Session to begin.</div>}
          {collab.active && collab.sessions.length === 0 && (
            <div className="ws-empty">Add an agent to open a session.</div>
          )}
          {collab.sessions.map((sid, i) => (
            <AgentPanel
              key={sid}
              index={i}
              workspaceId={w.id}
              sessionId={sid}
              transcript={w.transcriptById?.[sid]}
              perm={w.permById?.[sid]}
              meta={w.acpMetaById?.[sid]}
              annotations={w.annotations}
              drafts={w.drafts}
              status={w.statusById?.[sid]}
              selfId={selfId}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
