/**
 * collabDoc.js — collaborative Markdown documents (Yjs) shared over the app's single
 * WebSocket. One Y.Doc per open file, ref-counted by viewers. The server is a dumb
 * relay (it keeps a per-file replay log for late joiners but never merges); all merging
 * happens here in each browser's Y.Doc.
 *
 *   ydoc.getText("md")        the document text (bound to CodeMirror via yCollab)
 *   ydoc.getArray("annotations")  review annotations, anchored with relative positions
 *   awareness                 cursors/selections + {user:{id,name,color}} for labels
 *
 * terminalController owns the socket: it calls configureDocTransport() with a send fn
 * and routes inbound doc_* frames to the apply* handlers here. No import of the
 * controller here (avoids an import cycle).
 */
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates }
  from "y-protocols/awareness";
import { diffChars } from "diff";
import { colorForId, short } from "./idColor.js";

const docs = new Map();   // file -> entry
let _send = null;
export function configureDocTransport(send) { _send = send; }

// ── base64 <-> Uint8Array (Yjs updates / awareness blobs are binary) ──────────
function u8ToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToU8(b64) {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

// ── acquire / release (ref-counted per file) ──────────────────────────────────
export function acquireDoc(workspaceId, file, { selfId, seedText = "" } = {}) {
  let e = docs.get(file);
  if (e) { e.refs++; return e; }

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("md");
  const yann = ydoc.getArray("annotations");
  const awareness = new Awareness(ydoc);
  e = { workspaceId, file, ydoc, ytext, yann, awareness, refs: 1, updateCount: 0,
        seedText, selfId, hydrated: false, changeSubs: new Set(), announceTimer: null, knownClients: new Set() };
  docs.set(file, e);

  ydoc.on("update", (update, origin) => {
    e.changeSubs.forEach((cb) => { try { cb(); } catch (_) {} });   // refresh preview/annotations
    if (origin === "remote") return;                                // don't echo applied remote edits
    _send?.({ type: "doc_update", workspace_id: workspaceId, file, update: u8ToB64(update) });
    if (++e.updateCount >= 200) compact(e);
  });
  awareness.on("update", ({ added, updated, removed }, origin) => {
    if (origin === "remote") return;
    const clients = added.concat(updated, removed);
    _send?.({ type: "doc_awareness", workspace_id: workspaceId, file,
              state: u8ToB64(encodeAwarenessUpdate(awareness, clients)) });
  });
  // Set (and relay) our identity AFTER wiring, so peers learn about us immediately.
  awareness.setLocalStateField("user", { id: selfId, name: short(selfId), color: colorForId(selfId) });

  _send?.({ type: "doc_join", workspace_id: workspaceId, file });   // ask for the current log / seed decision
  return e;
}

export function releaseDoc(file) {
  const e = docs.get(file);
  if (!e || --e.refs > 0) return;
  try { e.awareness.setLocalState(null); } catch (_) {}   // relays our cursor removal to peers
  e.awareness.destroy();
  e.ydoc.destroy();
  docs.delete(file);
}

// Compaction: one elected client replaces the server log with a single full-state
// blob so join payloads stay bounded as edits accumulate.
function compact(e) {
  e.updateCount = 0;
  let min = e.ydoc.clientID;
  for (const [cid] of e.awareness.getStates()) min = Math.min(min, cid);
  if (e.ydoc.clientID !== min) return;   // not the leader
  _send?.({ type: "doc_state", workspace_id: e.workspaceId, file: e.file,
            state: u8ToB64(Y.encodeStateAsUpdate(e.ydoc)) });
}

// ── inbound (routed from terminalController) ──────────────────────────────────
export function applyDocSync(file, existed, updates) {
  const e = docs.get(file);
  if (!e) return;
  for (const u of updates || []) Y.applyUpdate(e.ydoc, b64ToU8(u), "remote");
  // Seed from disk if, AFTER applying the server's log, the doc is still empty and we
  // have disk content. Covers the first opener AND a lost/empty log — which would
  // otherwise leave an empty doc that a save could write back, TRUNCATING the file.
  if (e.ytext.length === 0 && e.seedText) {
    e.ydoc.transact(() => e.ytext.insert(0, e.seedText), "seed");
  }
  e.seedText = "";
  e.hydrated = true;   // the doc_join reply landed — safe to persist from now on
}
/** True once the doc_join reply has been applied (or the seed ran) — i.e. docText
 *  reflects real content, not the transient empty state right after acquireDoc. */
export function isDocHydrated(file) { const e = docs.get(file); return !!(e && e.hydrated); }
export function applyDocUpdate(file, updateB64) {
  const e = docs.get(file);
  if (e) Y.applyUpdate(e.ydoc, b64ToU8(updateB64), "remote");
}
export function applyDocAwareness(file, stateB64) {
  const e = docs.get(file);
  if (!e || !stateB64) return;
  applyAwarenessUpdate(e.awareness, b64ToU8(stateB64), "remote");
  // Awareness only broadcasts deltas, so a late joiner would miss existing cursors.
  // Re-announce our own state ONLY when a genuinely NEW client appears (not on every
  // cursor move) — otherwise two peers would ping-pong re-announcements forever.
  let fresh = false;
  for (const cid of e.awareness.getStates().keys()) {
    if (cid !== e.ydoc.clientID && !e.knownClients.has(cid)) { e.knownClients.add(cid); fresh = true; }
  }
  if (fresh && !e.announceTimer) {
    e.announceTimer = setTimeout(() => {
      e.announceTimer = null;
      _send?.({ type: "doc_awareness", workspace_id: e.workspaceId, file,
                state: u8ToB64(encodeAwarenessUpdate(e.awareness, [e.ydoc.clientID])) });
    }, 300);
  }
}
export function clearDocAwarenessUser(user) {
  for (const e of docs.values()) {
    for (const [cid, st] of e.awareness.getStates()) {
      if (st?.user?.id === user) removeAwarenessStates(e.awareness, [cid], "remote");
    }
  }
}

// ── read / subscribe (for the preview + non-yCollab consumers) ────────────────
export function getDocText(file) { const e = docs.get(file); return e ? e.ytext.toString() : ""; }
export function onDocChange(file, cb) {
  const e = docs.get(file);
  if (!e) return () => {};
  e.changeSubs.add(cb);
  return () => e.changeSubs.delete(cb);
}

// ── agent reconciliation: merge the agent's on-disk edit into the live doc ─────
// Plain-text diff into ytext (a transaction) so concurrent human edits survive and
// annotation/cursor anchors map through. Called by the authority client on idle.
export function mergeExternalText(file, newText) {
  const e = docs.get(file);
  if (!e) return;
  const old = e.ytext.toString();
  if (old === newText) return;
  e.ydoc.transact(() => {
    let idx = 0;
    for (const part of diffChars(old, newText)) {
      if (part.added) { e.ytext.insert(idx, part.value); idx += part.value.length; }
      else if (part.removed) { e.ytext.delete(idx, part.value.length); }
      else idx += part.value.length;
    }
  }, "agent");
}

// ── document annotations (stored in the Y.Doc, anchored with relative positions) ─
export function addDocAnnotation(file, { by, note, kind = "add", from, to }) {
  const e = docs.get(file);
  if (!e) return;
  const start = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(e.ytext, from));
  const end = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(e.ytext, to));
  e.ydoc.transact(() => e.yann.push([{ id: rid(), by, note, kind, start, end }]));
}
export function updateDocAnnotation(file, id, note) {
  const e = docs.get(file);
  if (!e) return;
  const i = e.yann.toArray().findIndex((a) => a.id === id);
  if (i < 0) return;
  const rec = { ...e.yann.get(i), note };
  e.ydoc.transact(() => { e.yann.delete(i, 1); e.yann.insert(i, [rec]); });
}
export function removeDocAnnotation(file, id) {
  const e = docs.get(file);
  if (!e) return;
  const i = e.yann.toArray().findIndex((a) => a.id === id);
  if (i >= 0) e.ydoc.transact(() => e.yann.delete(i, 1));
}
// Resolve each annotation's relative anchors to current absolute offsets + the text.
export function getDocAnnotations(file) {
  const e = docs.get(file);
  if (!e) return [];
  const full = e.ytext.toString();
  const out = [];
  for (const rec of e.yann.toArray()) {
    const s = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rec.start), e.ydoc);
    const t = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rec.end), e.ydoc);
    if (!s || !t || t.index <= s.index) continue;
    out.push({ ...rec, start: s.index, end: t.index, text: full.slice(s.index, t.index) });
  }
  return out;
}
