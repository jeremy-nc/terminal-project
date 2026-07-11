import React, { useRef, useLayoutEffect, useState, useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  collabForkSession, collabPrompt, collabChat,
  collabCancel, collabRemoveSession, sendAnnotationSelect, sendPromptTyping, updateDraftLocal,
  setAcpMode, setAcpModel, replyAcpPermission, collabTakeOver, collabReturn,
  collabAddAnnotation, collabRemoveAnnotation, collabClearAnnotations, collabExploreSelection,
  collabUpdateAnnotation,
} from "../terminalController.js";

export const EMPTY_ARR = [];  // stable ref so memo holds when a session has no annotations
export const annModalState = { addOpen: false };  // an "add" annotation modal is open — keep its highlight broadcast

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
function DraftCursors({ taRef, draft, text, selfId, tick }) {
  const [marks, setMarks] = useState([]);
  const cursors = draft.cursors || {};
  // Reflow against the LIVE textarea text (local state), not the throttled shared
  // draft — otherwise other users' carets lag your typing until the next sync.
  const sig = JSON.stringify(cursors) + "|" + (text || "");
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

// ── annotations: per-user colour + char-offset ↔ DOM Range helpers ────────────
export function colorForId(id) {
  let h = 0;
  for (let i = 0; i < (id || "").length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 80%, 60%)`;
}
export function offsetInRoot(root, node, nodeOffset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0, n;
  while ((n = walker.nextNode())) {
    if (n === node) return offset + nodeOffset;
    offset += n.textContent.length;
  }
  return offset + nodeOffset;
}
export function rangeFromOffsets(root, start, end) {
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
export function closestAnnRoot(node) {
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  return el && el.closest ? el.closest(".collab-msg[data-ann-seq]") : null;
}

export function short(id) { return (id || "").slice(0, 6); }

// Friendly labels for the agent's actions (ACP tool "kind") shown in the chat.
const TOOL_VERB = {
  search: "🔍 Find", execute: "⚡ Run", read: "📄 Read", edit: "✏️ Edit",
  delete: "🗑 Delete", move: "📦 Move", fetch: "🌐 Fetch (web)", think: "💭 Thinking",
  switch_mode: "🔀 Switch mode", delegate: "🤝 Delegate", other: "⚙ Working",
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

/** Highlights over agent messages for REVIEW annotations: a persistent amber box
 *  for each saved annotation (so you see what's already annotated), plus a live
 *  box for the pending selection while its "add a note" toolbar is open. */
function ReviewHighlights({ feedRef, annList, pending, sessionId, tick, onPick }) {
  const [boxes, setBoxes] = useState([]);
  const sig = JSON.stringify({
    a: annList.map((a) => [a.id, a.seq, a.start, a.end]),
    p: pending ? [pending.seq, pending.start, pending.end] : null,
  });
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed) { setBoxes([]); return; }
    const fr = feed.getBoundingClientRect();
    const out = [];
    const draw = (seq, start, end, cls, key, annId) => {
      if (start == null || end == null) return;
      const root = feed.querySelector(`.collab-msg[data-ann-seq="${seq}"][data-ann-sid="${sessionId}"]`);
      if (!root) return;
      const range = rangeFromOffsets(root, start, end);
      if (!range) return;
      let i = 0;
      for (const rc of range.getClientRects()) {
        out.push({ key: `${key}-${i++}`, cls, annId,
                   left: rc.left - fr.left, top: rc.top - fr.top + feed.scrollTop,
                   width: rc.width, height: rc.height });
      }
    };
    for (const a of annList) draw(a.seq, a.start, a.end, `saved ${a.kind === "fork" ? "fork" : "add"}`, a.id, a.id);
    if (pending) draw(pending.seq, pending.start, pending.end, "pending", "pending", null);
    setBoxes(out);
  }, [sig, tick]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="collab-annlayer review">
      {boxes.map((b) => (
        <div key={b.key} className={`collab-review-hl ${b.cls}${b.annId ? " clickable" : ""}`}
             style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
             onMouseDown={b.annId ? (e) => { e.stopPropagation(); onPick(b.annId, e.clientX, e.clientY); } : undefined} />
      ))}
    </div>
  );
}

const _pd = (e) => e.preventDefault();  // keep clicks from collapsing the selection

/** One modal for the whole annotation lifecycle — the SAME component drives the
 *  "add" toolbar (fresh selection), the "edit" popup (your latest-response note),
 *  and the read-only "view" popup (older / forked). `mode` toggles the controls. */
function AnnotationModal({ mode, snippet, kind = "add", by, note, setNote, x, y,
                          onAdd, onFork, onSave, onRemove, onClose }) {
  const editable = mode === "add" || mode === "edit";
  const isFork = kind === "fork";
  const snip = snippet.length > 90 ? snippet.slice(0, 90) + "…" : snippet;
  return (
    <div className={`collab-ann-modal${mode === "add" ? " wide" : ""}`} style={{ left: x + 6, top: y + 6 }}>
      <div className={`collab-ann-modal-snip ${isFork ? "fork" : "add"}`}>
        {isFork ? "🍴 " : ""}"{snip}"
      </div>
      {by && <div className="collab-ann-modal-by" style={{ color: colorForId(by) }} title={by}>by {short(by)}</div>}
      {editable ? (
        <div className="collab-ann-modal-row">
          <input className="collab-ann-modal-input" autoFocus value={note}
                 placeholder={mode === "add" ? "note / instruction…" : undefined}
                 onChange={(e) => setNote(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (mode === "add" ? onAdd : onSave)(); }
                                     else if (e.key === "Escape") onClose(); }} />
          {mode === "add" ? (
            <>
              <button className="collab-ann-modal-primary" onMouseDown={_pd} onClick={onAdd} disabled={!note.trim()}
                      title="Add as an annotation for the next prompt">💬 Add</button>
              <button className="collab-ann-modal-secondary" onMouseDown={_pd} onClick={onFork}
                      title="Fork a sub-agent to explore this (runs independently, can Return to this agent)">🍴 Fork</button>
            </>
          ) : (
            <button className="collab-ann-modal-primary" onMouseDown={_pd} onClick={onSave}>Save</button>
          )}
        </div>
      ) : (
        <div className="collab-ann-modal-note">
          {note}
          <span className="collab-ann-modal-tag">{isFork ? " · forked exploration (read-only)" : " · previous response (read-only)"}</span>
        </div>
      )}
      {mode !== "add" && (
        <button className="collab-ann-modal-del" onMouseDown={_pd} onClick={onRemove}>Remove</button>
      )}
    </div>
  );
}

function Bubble({ e, selfId, workspaceId, sessionId, annEnabled }) {
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
    // The data-ann-* attrs anchor annotation selections; omit them when annotations
    // are off so no selection handler engages over this surface's messages.
    const annAttrs = annEnabled ? { "data-ann-wid": workspaceId, "data-ann-sid": sessionId, "data-ann-seq": e.seq } : null;
    return (
      <div className="collab-bubble right agent">
        <div className="collab-msg" {...annAttrs}>
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

const DELEGATION_LABEL = {
  auto: "auto-running", watching: "watching · read-only", "human-gated": "you have control",
  returned: "returned", done: "finished",
};

const EMPTY_DRAFT = { text: "", cursors: {} };  // stable ref so memo holds when no draft
const EMPTY_FEATURES = {};  // stable ref so memo holds when features aren't passed (all on)

// Memoised: each panel gets only ITS OWN per-session slices (draft/transcript/…),
// so a change to one session (e.g. the ~90ms prompt-draft sync while typing) only
// re-renders that panel — not every panel's feed/overlays.
//
// The chat itself (feed + "Thinking…" + the collaborative shared prompt) is the same
// wherever an agent appears — the Collab panels and the Markdown editor both render
// THIS component. `features` turns off the Collab-only chrome for simpler surfaces:
//   header · fork · delegation · modelMode · annotations · chatInput  (all default on)
// `onSend(text)` overrides how a send is dispatched (Collab: collabPrompt; the editor
// saves the file first, then prompts) while keeping the shared-draft machinery intact.
export const AgentPanel = React.memo(function AgentPanel({ workspaceId, sessionId, transcript, perm, meta, annotations,
                     draft = EMPTY_DRAFT, status, selfId, index, delegation, parentIndex,
                     annList = EMPTY_ARR, features = EMPTY_FEATURES, onSend, placeholder, className = "", emptyHint }) {
  const feats = features || EMPTY_FEATURES;
  const showHeader = feats.header !== false;
  const showFork = feats.fork !== false;
  const showDelegation = feats.delegation !== false;
  const showModelMode = feats.modelMode !== false;
  const showAnnotations = feats.annotations !== false;
  const showChat = feats.chatInput !== false;
  const [chatText, setChatText] = useState("");
  const [tick, setTick] = useState(0);
  const typedAt = useRef(0);
  const taRef = useRef(null);
  const prevCaret = useRef(0);
  const entries = transcript?.entries || [];
  // The latest agent response's seq — only its "add" annotations are includable.
  const lastMsgSeq = entries.reduce((m, e) => (e.kind === "message" && e.seq > m ? e.seq : m), -1);
  const feed = useStick(transcript);
  const models = meta?.models, modes = meta?.modes;
  const thinking = status === "running";

  // Locally-controlled prompt text: the textarea reads THIS (instant echo), while
  // the global store + broadcast are updated on a throttle — so fast typing never
  // waits on a full-panel re-render or a WS round-trip per keystroke. Genuinely
  // remote edits to the shared draft are adopted below.
  const [text, setText] = useState(draft.text || "");
  const syncTimer = useRef(null);
  const pendingSync = useRef(null);
  const localAt = useRef(0);
  useEffect(() => {
    // Adopt a remote edit (someone else typed) — but not our own throttled echo
    // coming back through the store, and not while we're actively typing.
    if (draft.text !== text && Date.now() - localAt.current > 250) {
      setText(draft.text || "");
      const ta = taRef.current;
      if (ta) { const p = Math.min(prevCaret.current, (draft.text || "").length);
                try { ta.setSelectionRange(p, p); } catch (_) {} }
    }
  }, [draft.text]);  // eslint-disable-line react-hooks/exhaustive-deps
  const pushGlobal = (v, caret) => {
    pendingSync.current = { v, caret };
    if (syncTimer.current) return;
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null;
      const p = pendingSync.current;
      if (p) updateDraftLocal(workspaceId, sessionId, p.v, p.caret, selfId);
    }, 90);
  };

  // Slash-command menu over the shared prompt: shown when the draft starts with "/".
  const commands = meta?.commands || [];
  const slashFilter = (text || "").startsWith("/") ? text.slice(1).toLowerCase().split(/\s/)[0] : null;
  const shownCmds = slashFilter != null ? commands.filter((c) => (c.name || "").toLowerCase().includes(slashFilter)) : [];
  const pickCmd = (name) => {
    const t = `/${name} `;
    localAt.current = Date.now();
    setText(t);
    prevCaret.current = t.length;
    broadcastTyping(t, t.length, true);
    pushGlobal(t, t.length);
    taRef.current?.focus();
  };

  // Shared prompt draft: everyone edits the same text (last-writer-wins). The
  // broadcast to other windows is throttled (typing indicator + their view).
  const broadcastTyping = (val, cursor, force) => {
    const now = Date.now();
    if (!force && now - typedAt.current < 70) return;
    typedAt.current = now;
    sendPromptTyping(workspaceId, sessionId, val, cursor);
  };
  const onDraftChange = (e) => {
    const val = e.target.value, caret = e.target.selectionStart;
    localAt.current = Date.now();
    setText(val);                 // instant local echo — cheap, this panel only
    prevCaret.current = caret;
    broadcastTyping(val, caret);  // throttled WS to other windows
    pushGlobal(val, caret);       // throttled global-store sync (batched re-render)
  };
  const onDraftCaret = (e) => { prevCaret.current = e.target.selectionStart; broadcastTyping(text, e.target.selectionStart); };

  // Recompute annotation overlays on layout changes (window resize, streaming growth).
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
  }, []);
  useEffect(() => { setTick((t) => t + 1); }, [entries.length]);

  const sendAgent = () => {
    const t = (text || "").trim();
    if (t) {
      if (onSend) onSend(t); else collabPrompt(workspaceId, sessionId, t);
      localAt.current = Date.now();
      setText("");
      if (syncTimer.current) { clearTimeout(syncTimer.current); syncTimer.current = null; }
      pendingSync.current = null;
      updateDraftLocal(workspaceId, sessionId, "", 0, selfId);
      broadcastTyping("", 0, true);
    }
  };
  const sendChat = () => {
    const t = chatText.trim();
    if (t) { collabChat(workspaceId, sessionId, t); setChatText(""); }
  };

  // ── review annotations: highlight text in an agent message → add a note ──────
  const [annSel, setAnnSel] = useState(null);   // pending {seq, text, x, y}
  const [annNote, setAnnNote] = useState("");
  const [annPopup, setAnnPopup] = useState(null);  // viewing/editing {id, x, y}
  const [popNote, setPopNote] = useState("");
  // While the "add" modal is open, keep this user's collaborative highlight broadcast
  // (so other windows see what they're annotating), and clear it when the modal closes.
  useEffect(() => {
    if (!showAnnotations) return undefined;
    annModalState.addOpen = !!annSel;
    if (!annSel) return undefined;
    sendAnnotationSelect(workspaceId, sessionId, annSel.seq, annSel.start, annSel.end, false);
    return () => { sendAnnotationSelect(workspaceId, sessionId, annSel.seq, 0, 0, false); };
  }, [annSel, workspaceId, sessionId, showAnnotations]);
  const openAnnPopup = (id, x, y) => {
    const a = annList.find((z) => z.id === id);
    setAnnPopup({ id, x, y }); setPopNote(a?.note || "");
  };
  useEffect(() => {  // close the popup on outside click / Escape
    if (!annPopup) return undefined;
    const onDown = (e) => { if (!e.target.closest || !e.target.closest(".collab-ann-modal")) setAnnPopup(null); };
    const onKey = (e) => { if (e.key === "Escape") setAnnPopup(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [annPopup]);
  useEffect(() => {
    if (!showAnnotations) return undefined;
    const onUp = (e) => {
      if (e.target.closest && e.target.closest(".collab-ann-modal")) return;  // clicking the modal
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { setAnnSel(null); return; }
      const range = sel.getRangeAt(0);
      const root = closestAnnRoot(range.startContainer);
      if (!root || root.dataset.annSid !== sessionId || root !== closestAnnRoot(range.endContainer)) {
        setAnnSel(null); return;
      }
      const txt = sel.toString().trim();
      if (!txt) { setAnnSel(null); return; }
      const o1 = offsetInRoot(root, range.startContainer, range.startOffset);
      const o2 = offsetInRoot(root, range.endContainer, range.endOffset);
      const [start, end] = o1 <= o2 ? [o1, o2] : [o2, o1];
      const rect = range.getBoundingClientRect();
      setAnnSel({ seq: Number(root.dataset.annSeq), text: txt, start, end, x: rect.left, y: rect.bottom });
      setAnnNote("");
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [sessionId, showAnnotations]);
  const addAnnotation = () => {
    if (!annSel || !annNote.trim()) return;
    collabAddAnnotation(workspaceId, sessionId, annSel.seq, annSel.start, annSel.end, annSel.text, annNote.trim(), "add");
    setAnnSel(null); setAnnNote("");
    window.getSelection()?.removeAllRanges?.();
  };
  // Fork a sub-agent to explore the highlighted excerpt (runs independently; can
  // Return to this agent). Also saved as a BLUE "fork" annotation (never included).
  const forkFromSelection = () => {
    if (!annSel) return;
    collabAddAnnotation(workspaceId, sessionId, annSel.seq, annSel.start, annSel.end, annSel.text, annNote.trim(), "fork");
    collabExploreSelection(workspaceId, sessionId, annSel.text, annNote.trim());
    setAnnSel(null); setAnnNote("");
    window.getSelection()?.removeAllRanges?.();
  };
  // Only the LATEST response's "add" annotations are includable (fork ones never).
  const includable = annList.filter((a) => a.kind !== "fork" && a.seq === lastMsgSeq);
  // Compile them into the shared prompt (note BEFORE the highlighted text). Annotations
  // PERSIST — as the agent replies again, older ones simply stop being includable.
  const includeAnnotations = () => {
    if (!includable.length) return;
    const lines = includable.map((a) => `${a.note} - ${a.text}`).join("\n");
    const cur = (text || "").trim();
    const next = cur ? `${cur}\n${lines}` : lines;
    localAt.current = Date.now();
    setText(next); prevCaret.current = next.length;
    broadcastTyping(next, next.length); pushGlobal(next, next.length);
    taRef.current?.focus();
  };

  const dStatus = delegation?.status;
  return (
    <div className={`collab-panel${delegation ? " delegated" : ""}${dStatus === "human-gated" ? " gated" : ""}${dStatus === "watching" ? " watching" : ""}${className ? " " + className : ""}`}>
      {showHeader && (
      <div className="collab-panel-head">
        <span className="collab-panel-title">Agent {index + 1}</span>
        <span className="collab-panel-sid" title={sessionId}>{short(sessionId)}</span>
        {showDelegation && delegation && (
          <span className={`collab-deleg-badge ${dStatus}`}
                title={delegation.task ? `Delegated task: ${delegation.task}` : "Delegated sub-agent"}>
            ↳ from Agent {parentIndex >= 0 ? parentIndex + 1 : "?"} · {DELEGATION_LABEL[dStatus] || dStatus}
          </span>
        )}
        {(dStatus === "auto" || dStatus === "watching") && (
          <button className="collab-deleg-act take"
                  title={dStatus === "watching"
                    ? "Stop this autonomous sub-agent and resume it under your control"
                    : "Interrupt and take control of this sub-agent"}
                  onClick={() => collabTakeOver(workspaceId, sessionId)}>✋ Take over</button>
        )}
        {dStatus === "human-gated" && (
          <button className="collab-deleg-act return" title="Hand this sub-agent's result back to the coordinator"
                  onClick={() => collabReturn(workspaceId, sessionId, null)}>↩ Return to coordinator</button>
        )}
        {showFork && (
          <button className="collab-fork" title="Fork this session into a new panel"
                  onClick={() => collabForkSession(workspaceId, sessionId, null)}>⑂ Fork</button>
        )}
        <button className="collab-panel-btn" title="Interrupt the current turn"
                onClick={() => collabCancel(workspaceId, sessionId)}>⏹</button>
        <button className="collab-panel-btn close" title="Close this panel"
                onClick={() => collabRemoveSession(workspaceId, sessionId)}>×</button>
      </div>
      )}

      <div className="collab-feed" ref={feed.ref} onScroll={feed.onScroll}>
        {entries.length === 0 && <div className="text-faint">{emptyHint || "No messages yet."}</div>}
        {entries.map((e) => <Bubble key={e.seq} e={e} selfId={selfId} workspaceId={workspaceId} sessionId={sessionId} annEnabled={showAnnotations} />)}
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
        {showAnnotations && <>
          <AnnotationOverlay feedRef={feed.ref} annotations={annotations} sessionId={sessionId} selfId={selfId} tick={tick} />
          <ReviewHighlights feedRef={feed.ref} annList={annList} pending={annSel} sessionId={sessionId} tick={tick} onPick={openAnnPopup} />
        </>}
      </div>

      {showAnnotations && annSel && (
        <AnnotationModal mode="add" snippet={annSel.text} note={annNote} setNote={setAnnNote}
                         x={annSel.x} y={annSel.y}
                         onAdd={addAnnotation} onFork={forkFromSelection} onClose={() => setAnnSel(null)} />
      )}

      {showAnnotations && annPopup && (() => {
        const a = annList.find((z) => z.id === annPopup.id);
        if (!a) { return null; }
        const editable = a.kind !== "fork" && a.seq === lastMsgSeq;
        const close = () => setAnnPopup(null);
        return (
          <AnnotationModal mode={editable ? "edit" : "view"} snippet={a.text} kind={a.kind} by={a.by}
                           note={editable ? popNote : a.note} setNote={setPopNote}
                           x={annPopup.x} y={annPopup.y}
                           onSave={() => { collabUpdateAnnotation(workspaceId, sessionId, a.id, popNote.trim()); close(); }}
                           onRemove={() => { collabRemoveAnnotation(workspaceId, sessionId, a.id); close(); }}
                           onClose={close} />
        );
      })()}

      <div className="collab-inputs">
        {dStatus === "watching" ? (
          <div className="collab-readonly-note">👁 Read-only mirror of an autonomous sub-agent — <b>Take over</b> to interact.</div>
        ) : (<>
        {showAnnotations && includable.length > 0 && (
          <div className="collab-ann-list">
            <div className="collab-ann-head">
              <span className="collab-ann-count">📝 {includable.length} on this response</span>
              <button className="collab-ann-include" onClick={includeAnnotations}
                      title="Include this response's annotations in the prompt">
                Include in prompt ({includable.length})
              </button>
              <button className="collab-ann-clear" title="Clear all annotations"
                      onClick={() => collabClearAnnotations(workspaceId, sessionId)}>×</button>
            </div>
            {includable.map((a) => (
              <div key={a.id} className="collab-ann-item add" title="Click to edit"
                   onClick={(e) => openAnnPopup(a.id, e.clientX, e.clientY)}>
                {a.by && <span className="collab-ann-by" style={{ color: colorForId(a.by), borderColor: colorForId(a.by) }}
                               title={`by ${a.by}`}>{short(a.by)}</span>}
                <span className="collab-ann-snip" title={a.text}>
                  "{a.text.length > 40 ? a.text.slice(0, 40) + "…" : a.text}"
                </span>
                <span className="collab-ann-note">{a.note}</span>
                <button className="collab-ann-del" title="Remove"
                        onClick={(e) => { e.stopPropagation(); collabRemoveAnnotation(workspaceId, sessionId, a.id); }}>×</button>
              </div>
            ))}
          </div>
        )}
        {thinking && (
          <div className="acp-working"><span className="acp-dots"><i></i><i></i><i></i></span>Thinking…</div>
        )}
        {showModelMode && (models?.availableModels?.length || modes?.availableModes?.length) ? (
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
                      placeholder={placeholder || "Prompt the agent — shared, ⌘⏎ to send…"}
                      value={text}
                      onChange={onDraftChange} onSelect={onDraftCaret} onScroll={() => setTick((t) => t + 1)}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAgent(); } }} />
            <DraftCursors taRef={taRef} draft={draft} text={text} selfId={selfId} tick={tick} />
          </div>
          <button className="collab-send agent" onClick={sendAgent} disabled={!(text || "").trim()}>Send</button>
        </div>
        {showChat && (
        <div className="collab-input-row">
          <input className="collab-input" placeholder="Chat (not sent to agent)…" value={chatText}
                 onChange={(e) => setChatText(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }} />
          <button className="collab-send" onClick={sendChat} disabled={!chatText.trim()}>Send</button>
        </div>
        )}
        </>)}
      </div>
    </div>
  );
});
