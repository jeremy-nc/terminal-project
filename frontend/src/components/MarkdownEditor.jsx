import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import CodeMirror, { EditorView, Decoration, ViewPlugin, StateField, StateEffect } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { yCollab } from "y-codemirror.next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  readFile, writeFile, subscribe, getSnapshot, getSelfPresenceId,
  openEditorAgent, editorAgentPrompt, watchDocs, unwatchDocs, addAgentPromptItem,
} from "../terminalController.js";
import {
  acquireDoc, releaseDoc, getDocText, onDocChange, mergeExternalText, isDocHydrated,
  getDocAnnotations, addDocAnnotation, updateDocAnnotation, removeDocAnnotation,
} from "../collabDoc.js";
import { AgentPanel, AnnotationModal } from "./AgentPanel.jsx";
import { colorForId } from "../idColor.js";

// Editor agent uses the shared generic layout with the Collab-only chrome off.
const EDITOR_FEATURES = { header: false, fork: false, delegation: false, annotations: false };

// ── formatting toolbar: dispatch CodeMirror transactions (collaborative via yCollab) ─
const pd = (e) => e.preventDefault();   // keep the CM selection/focus when clicking a button
function cmWrap(view, before, after = before, ph = "") {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to) || ph;
  view.dispatch({ changes: { from, to, insert: before + sel + after },
                  selection: { anchor: from + before.length, head: from + before.length + sel.length } });
  view.focus();
}
function cmPrefix(view, prefix) {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const a = view.state.doc.lineAt(from).number, b = view.state.doc.lineAt(to).number;
  const changes = [];
  for (let n = a; n <= b; n++) { const ln = view.state.doc.line(n); changes.push({ from: ln.from, insert: prefix }); }
  view.dispatch({ changes });
  view.focus();
}
function cmInsert(view, text) {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
}

function EditorToolbar({ viewRef, onAttach }) {
  const run = (fn) => () => fn(viewRef.current);
  const B = ({ title, on, children }) => (
    <button className="md-tool" title={title} onMouseDown={pd} onClick={on}>{children}</button>
  );
  return (
    <div className="md-toolbar">
      <B title="Bold (**)" on={run((v) => cmWrap(v, "**", "**", "bold"))}><b>B</b></B>
      <B title="Italic (*)" on={run((v) => cmWrap(v, "*", "*", "italic"))}><i>I</i></B>
      <B title="Strikethrough (~~)" on={run((v) => cmWrap(v, "~~", "~~", "text"))}><s>S</s></B>
      <span className="md-tool-sep" />
      <B title="Heading 1" on={run((v) => cmPrefix(v, "# "))}>H1</B>
      <B title="Heading 2" on={run((v) => cmPrefix(v, "## "))}>H2</B>
      <B title="Quote" on={run((v) => cmPrefix(v, "> "))}>❝</B>
      <span className="md-tool-sep" />
      <B title="Inline code (`)" on={run((v) => cmWrap(v, "`", "`", "code"))}>{"<>"}</B>
      <B title="Code block" on={run((v) => cmWrap(v, "```\n", "\n```", "code"))}>▤</B>
      <B title="Link" on={run((v) => cmWrap(v, "[", "](url)", "text"))}>🔗</B>
      <B title="Bulleted list" on={run((v) => cmPrefix(v, "- "))}>•</B>
      <B title="Numbered list" on={run((v) => cmPrefix(v, "1. "))}>1.</B>
      <span className="md-tool-sep" />
      <B title="Attach image" on={onAttach}>🖼</B>
    </div>
  );
}

const VIEW_MODES = [["source", "◧", "Editor only"], ["split", "▥", "Split"], ["preview", "▤", "Preview only"]];

// ── CodeMirror extension: render doc annotations as coloured highlights, capture a
//    fresh selection to annotate, and open a saved one on click. Decorations are
//    rebuilt (deferred) whenever the Y.Doc changes — including annotation adds, which
//    don't touch the CM text — and map through edits in between. ────────────────────
const setAnnos = StateEffect.define();
const annoField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setAnnos)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
function buildAnnoDecos(path) {
  const marks = getDocAnnotations(path)
    .filter((a) => a.end > a.start)
    .map((a) => Decoration.mark({
      class: `cm-doc-ann${a.kind === "fork" ? " fork" : ""}`,
      attributes: { "data-ann-id": a.id, style: `--ann:${colorForId(a.by)}` },
    }).range(a.start, a.end));
  return Decoration.set(marks, true);
}
function docAnnotationExtensions(path, onSelect, onPick) {
  const refresh = ViewPlugin.define((view) => {
    const push = () => setTimeout(() => { try { view.dispatch({ effects: setAnnos.of(buildAnnoDecos(path)) }); } catch (_) {} }, 0);
    push();
    const off = onDocChange(path, push);   // annotation adds/edits live in the Y.Doc
    return { destroy: off };
  });
  const selection = EditorView.updateListener.of((u) => {
    if (!u.selectionSet) return;   // only react to THIS user's selection, not remote edits
    const r = u.state.selection.main;
    if (r.empty) { onSelect(null); return; }
    const c = u.view.coordsAtPos(r.to);
    if (c) onSelect({ from: r.from, to: r.to, text: u.state.sliceDoc(r.from, r.to), left: c.left, top: c.bottom });
  });
  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = e.target.closest?.(".cm-doc-ann");
      if (el && view.state.selection.main.empty) onPick(el.getAttribute("data-ann-id"), e.clientX, e.clientY);
    },
  });
  return [annoField, refresh, selection, clicks];
}

/** Markdown editor overlay: a real-time COLLABORATIVE CodeMirror document (Yjs) with a
 *  live preview + the shared editor agent. Concurrent edits merge, remote cursors show
 *  with user IDs, and highlight→note annotations sync over the same Y.Doc. Falls back
 *  to a solo editor when no Collab session is running. */
export default function MarkdownEditor({ path, workspaceId, collabActive, onClose }) {
  const [content, setContent] = useState(null);   // null = loading; also the seed + solo buffer
  const [docText, setDocText] = useState("");      // collaborative text mirror (for preview + save)
  const [dirty, setDirty] = useState(false);       // solo-only (collab autosaves the shared doc)
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [agentSid, setAgentSid] = useState(null);
  const [entry, setEntry] = useState(null);        // acquired Y.Doc entry (collab)
  const [annSel, setAnnSel] = useState(null);      // pending add {from,to,text,x,y}
  const [annNote, setAnnNote] = useState("");
  const [annPopup, setAnnPopup] = useState(null);  // view/edit {id,x,y}
  const [popNote, setPopNote] = useState("");
  const [viewMode, setViewMode] = useState("split");   // source | split | preview
  const paneRef = useRef(null);
  const cmViewRef = useRef(null);                  // live EditorView, for the toolbar
  const fileInputRef = useRef(null);
  const sentPrompt = useRef(false);                // this window sent the last prompt → it owns the merge
  const selfId = getSelfPresenceId();
  const collab = collabActive && !!entry;

  const state = useSyncExternalStore(subscribe, getSnapshot);
  const ws = state.workspaces?.find((x) => x.id === workspaceId);
  const agentStatus = agentSid ? ws?.statusById?.[agentSid] : null;

  const text = collab ? docText : (content ?? "");
  const textRef = useRef("");
  textRef.current = text;

  // Ensure THIS file's directory is in the backend's watched set for as long as the
  // editor is open — so read/write is permitted even if the DocsExplorer registration
  // was lost (e.g. the in-memory set was reset by a server restart and the socket
  // didn't re-open). This is the security boundary (DocsService.is_allowed).
  useEffect(() => {
    const dir = path.replace(/\/[^/]*$/, "");
    if (!dir) return undefined;
    watchDocs(dir);
    return () => unwatchDocs(dir);
  }, [path]);

  // Load the file (seed for collab, buffer for solo). Retry a "not permitted" a few
  // times: registering the dir (above) races the read, since set_watched runs off-loop.
  useEffect(() => {
    let alive = true;
    setContent(null); setDirty(false); setError(null);
    const attempt = (left) => readFile(path)
      .then((c) => { if (alive) setContent(c); })
      .catch((e) => {
        if (alive && left > 0 && /not permitted/i.test(String(e.message))) { setTimeout(() => attempt(left - 1), 300); return; }
        if (alive) setError(String(e.message || e));
      });
    attempt(4);
    return () => { alive = false; };
  }, [path]);

  // Acquire the shared Y.Doc once the file is loaded (collab only); seed from disk.
  useEffect(() => {
    if (!collabActive || content == null) return undefined;
    const e = acquireDoc(workspaceId, path, { selfId, seedText: content });
    setEntry(e);
    setDocText(getDocText(path));
    const off = onDocChange(path, () => setDocText(getDocText(path)));
    return () => { off(); releaseDoc(path); setEntry(null); };
  }, [path, workspaceId, collabActive, content == null]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Attach to the file's shared agent (see AgentPanel); persists across modal close.
  useEffect(() => {
    if (!collabActive) return undefined;
    let alive = true;
    openEditorAgent(workspaceId, path).then((s) => { if (alive && s) setAgentSid(s); }).catch(() => {});
    return () => { alive = false; setAgentSid(null); };
  }, [path, workspaceId, collabActive]);

  // Agent finished a turn (running→idle): the file changed on disk. The window that
  // sent the prompt merges it into the live doc (others receive it via Yjs); solo just
  // reloads. If the sender left, the next save reconciles.
  const prevStatus = useRef(null);
  useEffect(() => {
    if (prevStatus.current === "running" && agentStatus === "idle") {
      readFile(path).then((c) => {
        if (collab) { if (sentPrompt.current) { mergeExternalText(path, c); sentPrompt.current = false; } }
        else { setContent(c); setDirty(false); }
      }).catch(() => {});
    }
    prevStatus.current = agentStatus;
  }, [agentStatus, path, collab]);

  // Guard EVERY disk write against corruption: never persist before the collaborative
  // doc has hydrated (its content is transiently "" right after open, until the doc_join
  // reply lands), and never let an empty doc overwrite a file that was loaded non-empty
  // (a desync/unseeded state). `content` in collab stays = the originally-loaded disk
  // text, so it's the right "was there content?" baseline.
  const canPersist = (txt) => {
    if (collab && !isDocHydrated(path)) return false;
    if (txt === "" && (content ?? "") !== "") return false;
    return true;
  };

  // Debounced autosave of the collaborative doc to disk (durability + so the agent's
  // cwd sees current text between turns).
  useEffect(() => {
    if (!collab) return undefined;
    const t = setTimeout(() => { if (canPersist(docText)) writeFile(path, docText).catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, [collab, path, docText, content]);  // eslint-disable-line react-hooks/exhaustive-deps

  // When the source becomes visible again, tell CodeMirror to re-measure (it was
  // display:none, i.e. zero-sized, so its layout is stale until we ask).
  useEffect(() => {
    if (viewMode !== "preview" && cmViewRef.current) {
      requestAnimationFrame(() => cmViewRef.current?.requestMeasure());
    }
  }, [viewMode]);

  const save = async () => {
    if (!canPersist(textRef.current)) { setError("Not saved — document is still syncing."); return; }
    setSaving(true); setError(null);
    try { await writeFile(path, textRef.current); setDirty(false); }
    catch (e) { setError(String(e.message || e)); }
    finally { setSaving(false); }
  };
  const onAgentSend = async (t) => {
    sentPrompt.current = true;
    // Only push the buffer to disk if it's safe; otherwise leave the last-good file for
    // the agent to read (don't hand it an empty/unsynced doc).
    if (canPersist(textRef.current)) { try { await writeFile(path, textRef.current); setDirty(false); } catch (_) { /* keep going */ } }
    if (agentSid) editorAgentPrompt(workspaceId, agentSid, t);
  };
  const close = () => { if (dirty && !window.confirm("Discard unsaved changes?")) return; onClose(); };

  // Annotation coords are viewport-based; place the modal relative to the editor pane.
  const rel = (x, y) => {
    const r = paneRef.current?.getBoundingClientRect();
    return r ? { x: x - r.left, y: y - r.top } : { x, y };
  };
  const onSelect = (sel) => {
    if (!sel) { setAnnSel(null); return; }
    const { x, y } = rel(sel.left, sel.top);
    setAnnSel({ from: sel.from, to: sel.to, text: sel.text, x, y }); setAnnNote("");
  };
  const openPopup = (id, cx, cy) => {
    const a = getDocAnnotations(path).find((z) => z.id === id);
    if (!a) return;
    const { x, y } = rel(cx, cy);
    setAnnPopup({ id, x, y }); setPopNote(a.note || "");
  };
  const addAnnotation = () => {
    if (!annSel || !annNote.trim()) return;
    addDocAnnotation(path, { by: selfId, note: annNote.trim(), kind: "add", from: annSel.from, to: annSel.to });
    setAnnSel(null); setAnnNote("");
  };
  // Send the selected raw markdown + the typed instruction to the agent panel as an
  // "edit" item (not a doc annotation) — an external input to the shared prompt list.
  const suggestEditToAgent = () => {
    if (!annSel || !annNote.trim() || !agentSid) return;
    addAgentPromptItem(workspaceId, agentSid, { kind: "edit", text: annSel.text, note: annNote.trim() });
    setAnnSel(null); setAnnNote("");
  };

  // Attach an image: embed as a data URI so it's self-contained + renders in preview.
  const onAttachClick = () => fileInputRef.current?.click();
  const onImageFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) { setError("Image too large (max 3 MB)."); return; }
    const reader = new FileReader();
    reader.onload = () => cmInsert(cmViewRef.current, `![${f.name}](${reader.result})`);
    reader.readAsDataURL(f);
  };

  const cmExtensions = useMemo(() => {
    if (!entry) return null;
    return [
      markdown(), EditorView.lineWrapping,
      yCollab(entry.ytext, entry.awareness),
      ...docAnnotationExtensions(path, onSelect, openPopup),
    ];
  }, [entry, path]);  // eslint-disable-line react-hooks/exhaustive-deps

  const name = (path || "").split("/").pop();
  const thinking = agentStatus === "running";
  const annList = collab ? getDocAnnotations(path) : [];
  const popAnn = annPopup && annList.find((a) => a.id === annPopup.id);
  return (
    <div className="md-editor-overlay">
      <div className="md-editor-head">
        <span className="md-editor-name">📝 {name}{!collab && dirty ? " ●" : ""}
          {collab && <span className="md-editor-live" title="Collaborative — edits sync live"> · live</span>}</span>
        <div className="md-viewtoggle">
          {VIEW_MODES.map(([m, glyph, title]) => (
            <button key={m} className={`md-vt${viewMode === m ? " on" : ""}`} title={title}
                    onClick={() => setViewMode(m)}>{glyph}</button>
          ))}
        </div>
        <button className="md-editor-save" onClick={save} disabled={saving || content == null || (!collab && !dirty)}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="md-editor-close" title="Close" onClick={close}>×</button>
      </div>
      <div className="md-editor-split">
        <div className={`md-editor-pane cm${viewMode === "preview" ? " md-hidden" : ""}`} data-color-mode="dark" ref={paneRef}>
          {error ? (
            <div className="md-editor-msg err">⚠ {error}</div>
          ) : content == null ? (
            <div className="md-editor-msg">Loading…</div>
          ) : collabActive && !entry ? (
            <div className="md-editor-msg">Connecting…</div>
          ) : (
            <>
              <EditorToolbar viewRef={cmViewRef} onAttach={onAttachClick} />
              <div className="md-cm-wrap">
                {collab ? (
                  <CodeMirror height="100%" theme="dark" extensions={cmExtensions}
                              basicSetup={{ lineNumbers: false, foldGutter: false }}
                              onCreateEditor={(v) => { cmViewRef.current = v; }} />
                ) : (
                  <CodeMirror value={content} height="100%" theme="dark"
                              extensions={[markdown(), EditorView.lineWrapping]}
                              basicSetup={{ lineNumbers: false, foldGutter: false }}
                              onCreateEditor={(v) => { cmViewRef.current = v; }}
                              onChange={(v) => { setContent(v ?? ""); setDirty(true); }} />
                )}
              </div>
            </>
          )}
          {annSel && (
            <AnnotationModal mode="add" snippet={annSel.text} note={annNote} setNote={setAnnNote}
                             x={annSel.x} y={annSel.y} allowFork={false}
                             onAdd={addAnnotation} onToAgent={agentSid ? suggestEditToAgent : undefined}
                             onClose={() => setAnnSel(null)} />
          )}
          {popAnn && (
            <AnnotationModal mode="edit" snippet={popAnn.text} by={popAnn.by} note={popNote} setNote={setPopNote}
                             x={annPopup.x} y={annPopup.y}
                             onSave={() => { updateDocAnnotation(path, popAnn.id, popNote.trim()); setAnnPopup(null); }}
                             onRemove={() => { removeDocAnnotation(path, popAnn.id); setAnnPopup(null); }}
                             onClose={() => setAnnPopup(null)} />
          )}
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onImageFile} />
        </div>
        <div className={`md-editor-preview${viewMode === "source" ? " md-hidden" : ""}`} data-color-mode="dark">
          <Markdown remarkPlugins={[remarkGfm]}>{text || ""}</Markdown>
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
              transcript={agentSid ? ws?.transcriptById?.[agentSid] : null}
              status={agentStatus}
              draft={agentSid ? ws?.drafts?.[agentSid] : undefined}
              meta={agentSid ? ws?.acpMetaById?.[agentSid] : undefined}
              perm={agentSid ? ws?.permById?.[agentSid] : undefined}
              selfId={selfId}
              index={0}
              features={EDITOR_FEATURES}
              promptItems={agentSid ? ws?.promptItemsBySession?.[agentSid] : undefined}
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
