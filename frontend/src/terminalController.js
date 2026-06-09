/**
 * terminalController.js
 *
 * Owns the single WebSocket, all xterm Terminal + FitAddon instances, and the
 * session-routing maps.  React components call action methods and subscribe to
 * the snapshot for re-rendering via useSyncExternalStore.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { b64dec, strToB64 } from "./wire.js";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// ── state shape ─────────────────────────────────────────────────────────────
let _state = {
  status: "connecting", // "connecting" | "open" | "closed"
  tabs: [],             // [{ id, title, sessionId, status }]
  activeTabId: null,
};

let _tabCounter = 0;

// ── internal registries ──────────────────────────────────────────────────────
const _terms = new Map();    // tabId → { main: Terminal, mirror: Terminal, mainFit, mirrorFit }
const _bySession = new Map(); // sessionId → tabId

// ── subscriber list (for useSyncExternalStore) ───────────────────────────────
const _listeners = new Set();
function _notify() { _listeners.forEach((l) => l()); }

function _setState(patch) {
  _state = { ..._state, ...patch };
  _notify();
}

function _patchTab(tabId, patch) {
  _setState({
    tabs: _state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  });
}

// ── WebSocket ────────────────────────────────────────────────────────────────
let _ws = null;

function _send(obj) {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(obj));
  }
}

function _connect() {
  // Never open a second socket: a duplicate connection desyncs session
  // routing because "started" replies can arrive on either socket.
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  _ws = new WebSocket(WS_URL);

  _ws.onopen = () => {
    _setState({ status: "open" });
    // Reopen any tabs that were waiting (e.g. after reconnect)
    for (const t of _state.tabs) {
      if (t.status === "starting") _sendStart(t.id);
    }
  };

  _ws.onclose = (ev) => {
    // Ignore stale handlers from a socket we've already replaced.
    if (ev.target !== _ws) return;
    _ws = null;
    _setState({ status: "closed" });
    setTimeout(_connect, 2000); // auto-reconnect
  };

  _ws.onmessage = (ev) => {
    try {
      _handleMsg(JSON.parse(ev.data));
    } catch (err) {
      console.error("[ws] parse/handle error:", err);
    }
  };
}

function _handleMsg(msg) {
  switch (msg.type) {
    case "started": {
      // Correlate by the client id we sent on "start" (not by arrival order),
      // so a tab is matched to its session even if replies interleave.
      const tabId = msg.cid;
      if (!tabId) return;
      const tab = _state.tabs.find((t) => t.id === tabId);
      if (!tab) return; // tab was closed before its session came up
      _bySession.set(msg.id, tabId);
      _patchTab(tabId, { sessionId: msg.id, status: "running" });
      break;
    }
    case "replay":
    case "stdout": {
      const tabId = _bySession.get(msg.id);
      if (!tabId) return;
      const rec = _terms.get(tabId);
      if (!rec) return;
      const data = b64dec(msg.data);
      rec.main.write(data);
      rec.mirror.write(data);
      break;
    }
    case "exit": {
      const tabId = _bySession.get(msg.id);
      if (tabId) _patchTab(tabId, { status: "exited" });
      break;
    }
    case "error":
      console.warn("[ws] server error:", msg.message);
      break;
  }
}

// ── tab lifecycle ────────────────────────────────────────────────────────────
function _sendStart(tabId) {
  const rec = _terms.get(tabId);
  const cols = rec ? rec.main.cols : 80;
  const rows = rec ? rec.main.rows : 24;
  // cid lets the server echo back which tab this session belongs to.
  _send({ type: "start", shell: "bash", cols, rows, cid: tabId });
}

export function newTab() {
  const id = `tab-${++_tabCounter}`;
  const title = `bash #${_tabCounter}`;
  const tab = { id, title, sessionId: null, status: "starting" };
  _setState({ tabs: [..._state.tabs, tab], activeTabId: id });
  // If WS already open, start will be sent from mountTab once terminals exist.
  return id;
}

/** Called by TabStage once its host divs are in the DOM. */
export function mountTab(tabId, mainHost, mirrorHost) {
  if (_terms.has(tabId)) return; // already mounted

  const main = new Terminal({
    theme: { background: "#1e1e1e", foreground: "#ddd" },
    fontSize: 14, cursorBlink: true, allowTransparency: false,
  });
  const mirror = new Terminal({
    theme: { background: "#15171a", foreground: "#aaa" },
    fontSize: 9, cursorBlink: false, disableStdin: true,
  });

  const mainFit = new FitAddon();
  const mirrorFit = new FitAddon();
  main.loadAddon(mainFit);
  mirror.loadAddon(mirrorFit);

  main.open(mainHost);
  mirror.open(mirrorHost);

  main.onData((data) => {
    const tab = _state.tabs.find((t) => t.id === tabId);
    if (tab?.sessionId && tab.status === "running") {
      _send({ type: "stdin", id: tab.sessionId, data: strToB64(data) });
    }
  });

  // Register the session BEFORE fitting: a fit() failure on a freshly
  // shown host must never prevent the session from starting.
  _terms.set(tabId, { main, mirror, mainFit, mirrorFit });

  // Start immediately so the tab is not gated on layout; the PTY accepts
  // a later resize. Fit now (best-effort) and again after the next paint.
  if (_ws?.readyState === WebSocket.OPEN) _sendStart(tabId);
  fitTab(tabId);
  requestAnimationFrame(() => fitTab(tabId));
}

/** Called by TabStage's cleanup effect before the host divs are removed. */
export function unmountTab(tabId) {
  const rec = _terms.get(tabId);
  if (!rec) return;
  rec.main.dispose();
  rec.mirror.dispose();
  _terms.delete(tabId);
}

export function activateTab(tabId) {
  _setState({ activeTabId: tabId });
  // Refit after the new tab's hosts become visible (next microtask).
  setTimeout(() => fitTab(tabId), 0);
}

export function closeTab(tabId) {
  const tab = _state.tabs.find((t) => t.id === tabId);
  if (tab?.sessionId) _send({ type: "close", id: tab.sessionId });
  if (tab?.sessionId) _bySession.delete(tab.sessionId);

  const remaining = _state.tabs.filter((t) => t.id !== tabId);
  const nextActive =
    _state.activeTabId === tabId
      ? remaining[remaining.length - 1]?.id ?? null
      : _state.activeTabId;
  _setState({ tabs: remaining, activeTabId: nextActive });
  // unmountTab called by the TabStage cleanup effect
}

export function restartTab(tabId) {
  const tab = _state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (tab.sessionId) {
    _send({ type: "close", id: tab.sessionId });
    _bySession.delete(tab.sessionId);
  }
  // Clear terminal buffers
  const rec = _terms.get(tabId);
  if (rec) { rec.main.reset(); rec.mirror.reset(); }
  _patchTab(tabId, { sessionId: null, status: "starting" });
  if (_ws?.readyState === WebSocket.OPEN) _sendStart(tabId);
}

export function sendStdin(data) {
  const tab = _state.tabs.find((t) => t.id === _state.activeTabId);
  if (tab?.sessionId && tab.status === "running") {
    _send({ type: "stdin", id: tab.sessionId, data: strToB64(data) });
  }
}

export function fitTab(tabId) {
  const rec = _terms.get(tabId);
  if (!rec) return;
  try {
    rec.mainFit.fit();
    rec.mirrorFit.fit();
    const tab = _state.tabs.find((t) => t.id === tabId);
    if (tab?.sessionId && tab.status === "running") {
      _send({ type: "resize", id: tab.sessionId, cols: rec.main.cols, rows: rec.main.rows });
    }
  } catch (_) {}
}

export function fitActive() {
  if (_state.activeTabId) fitTab(_state.activeTabId);
}

// ── useSyncExternalStore API ─────────────────────────────────────────────────
export function subscribe(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

export function getSnapshot() { return _state; }

// ── bootstrap ────────────────────────────────────────────────────────────────
_connect();
