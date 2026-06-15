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
  tabs: [],             // interactive shells + pipeline node cards (isNode, workspaceId)
  activeTabId: null,
  // Workspaces ("sessions"): each is a persisted definition (id/name/dir/dsl)
  // PLUS its live run state, updated by events routed via workspace_id. Several
  // can run concurrently; the dashboard renders the active one.
  workspaces: [],       // [{ id, name, dir, dsl, status, spec, statusById, sessionById, childrenByParent, outputs, result, warnings, error, currentStage }]
  activeWorkspaceId: null,
};

let _tabCounter = 0;

// Node-card tab id, namespaced per workspace so the same node id (n0, n1/0, …)
// in two concurrent workspaces never collides in the tabs list or _terms map.
function _nodeTabId(wid, nodeId) { return `${wid}::node-${nodeId}`; }

function _blankRunState() {
  return {
    status: "idle", spec: null, statusById: {}, sessionById: {},
    childrenByParent: {}, outputs: {}, result: null,
    warnings: [], error: null, currentStage: null,
  };
}

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

// Update one workspace's run state by id. `patch` may be an object or a
// function (prev) => patch, like a React reducer.
function _patchWorkspace(wid, patch) {
  _setState({
    workspaces: _state.workspaces.map((w) =>
      w.id === wid ? { ...w, ...(typeof patch === "function" ? patch(w) : patch) } : w
    ),
  });
}

// Drop a workspace's node cards + their session routing (on (re-)run, so the
// new run's cards re-mount fresh and attach to the new sessions).
function _clearWorkspaceNodeTabs(wid) {
  const kept = [];
  for (const t of _state.tabs) {
    if (t.isNode && t.workspaceId === wid) {
      if (t.sessionId) _bySession.delete(t.sessionId);
    } else {
      kept.push(t);
    }
  }
  _setState({ tabs: kept });
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
    // Fetch the persisted workspace list (definitions) for the pipeline view.
    _send({ type: "list_workspaces" });
    // Reopen any interactive tabs that were waiting (e.g. after reconnect)
    for (const t of _state.tabs) {
      if (t.status === "starting" && !t.isNode) _sendStart(t.id);
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

// Does this spec node's subtree contain nodeId? (fan-out children are minted
// at runtime as `${parent.id}/${i}`, so match that prefix too.)
function _subtreeHasNode(node, nodeId) {
  if (!node) return false;
  if (node.id === nodeId) return true;
  if (typeof nodeId === "string" && typeof node.id === "string" && nodeId.startsWith(node.id + "/")) return true;
  return Array.isArray(node.nodes) && node.nodes.some((c) => _subtreeHasNode(c, nodeId));
}

// The top-level pipeline stage (root sequence's direct child) that contains a
// node — the "container" the view scrolls to when that stage starts running.
function _stageContaining(spec, nodeId) {
  if (!spec || spec.type !== "sequence" || !Array.isArray(spec.nodes)) return null;
  const stage = spec.nodes.find((s) => _subtreeHasNode(s, nodeId));
  return stage ? stage.id : null;
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
      rec.mirror?.write(data);
      break;
    }
    case "exit": {
      const tabId = _bySession.get(msg.id);
      if (tabId) _patchTab(tabId, { status: "exited" });
      break;
    }
    case "workspace_list": {
      // The server's source of truth for which workspaces exist. Merge in
      // definitions, preserving each existing workspace's live run state and
      // its locally-edited dsl (only newly-appearing ones adopt the server dsl).
      const defs = msg.workspaces || [];
      const existing = new Map(_state.workspaces.map((w) => [w.id, w]));
      const merged = defs.map((d) =>
        existing.has(d.id)
          ? { ...existing.get(d.id), name: d.name, dir: d.dir }
          : { id: d.id, name: d.name, dir: d.dir, dsl: d.dsl || "", ..._blankRunState() }
      );
      let active = msg.created || _state.activeWorkspaceId;
      if (!merged.find((w) => w.id === active)) active = merged[0]?.id ?? null;
      _setState({ workspaces: merged, activeWorkspaceId: active });
      break;
    }
    case "pipeline_started": {
      const wid = msg.workspace_id;
      if (!wid) break;
      // Re-runs reuse node ids, so clear the previous run's node cards first.
      _clearWorkspaceNodeTabs(wid);
      _patchWorkspace(wid, (w) => ({ ..._blankRunState(), spec: w.spec, status: "running" }));
      break;
    }
    case "pipeline_finished": {
      // msg.outputs is the coordinator's full map: { node_id: {output(b64), exit_code} }
      _patchWorkspace(msg.workspace_id, { status: "finished", result: msg.result, outputs: msg.outputs || {} });
      break;
    }
    case "pipeline_error": {
      _patchWorkspace(msg.workspace_id, { status: "error", error: msg.message });
      break;
    }
    case "node_warning": {
      _patchWorkspace(msg.workspace_id, (w) => ({ warnings: [...(w.warnings || []), msg.message] }));
      break;
    }
    case "node_started": {
      // Only terminal (leaf) nodes own a live session; batch/sequence wrappers
      // are drawn from the spec tree. Internal plumbing nodes (e.g. the
      // dynamic-batch structurer) run server-side but aren't surfaced as cards.
      const wid = msg.workspace_id;
      if (msg.node_type === "terminal" && !msg.internal && wid) {
        const nodeId = msg.node_id;
        const parentId = msg.node_id != null ? msg.parent_id : null;
        const tabId = _nodeTabId(wid, nodeId);
        if (!_state.tabs.find((t) => t.id === tabId)) {
          const tab = { id: tabId, title: `Job ${nodeId}`, sessionId: msg.id, status: "running", isNode: true, workspaceId: wid, nodeId };
          _bySession.set(msg.id, tabId);
          _setState({ tabs: [..._state.tabs, tab] });
          _patchWorkspace(wid, (w) => ({
            statusById: { ...w.statusById, [nodeId]: "running" },
            sessionById: { ...w.sessionById, [nodeId]: msg.id },
            // Runtime-spawned fan-out children carry a parent_id; nest under it.
            childrenByParent: parentId != null
              ? { ...w.childrenByParent, [parentId]: [
                  ...(w.childrenByParent?.[parentId] || []).filter((c) => c.nodeId !== nodeId),
                  { nodeId, argv: msg.argv, sessionId: msg.id },
                ] }
              : (w.childrenByParent || {}),
            currentStage: _stageContaining(w.spec, nodeId) || w.currentStage,
          }));
        }
      }
      break;
    }
    case "node_finished": {
      // Wrapper (batch/sequence) finishes carry no node_id; ignore those here.
      const wid = msg.workspace_id;
      if (msg.node_id == null || !wid) break;
      _patchWorkspace(wid, (w) => ({
        statusById: { ...w.statusById, [msg.node_id]: "finished" },
        outputs: msg.output != null
          ? { ...(w.outputs || {}), [msg.node_id]: { output: msg.output, exit_code: msg.exit_code } }
          : (w.outputs || {}),
      }));
      break;
    }
    case "needs_input": {
      const tabId = _bySession.get(msg.id);
      if (tabId) _patchTab(tabId, { needsInput: true });
      const wid = msg.workspace_id;
      if (msg.node_id != null && wid) {
        _patchWorkspace(wid, (w) => ({ statusById: { ...w.statusById, [msg.node_id]: "waiting" } }));
      }
      break;
    }
    case "node_status": {
      // Explicit status transition (e.g. a coordinator resuming after ask_user).
      const wid = msg.workspace_id;
      if (msg.node_id == null || !wid) break;
      _patchWorkspace(wid, (w) => ({ statusById: { ...w.statusById, [msg.node_id]: msg.status } }));
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
  // Record the dims we started at so fitTab won't send a redundant resize
  // (which would SIGWINCH the shell into reprinting its prompt).
  if (rec) { rec._lastCols = cols; rec._lastRows = rows; }
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

  const mono = '"SF Mono", "JetBrains Mono", ui-monospace, "Menlo", monospace';
  const main = new Terminal({
    theme: {
      background: "#111113",
      foreground: "#ededef",
      cursor: "#7c6cff",
      cursorAccent: "#111113",
      selectionBackground: "rgba(124, 108, 255, 0.30)",
    },
    fontFamily: mono,
    fontSize: 14, cursorBlink: true, allowTransparency: false,
  });
  const mirror = new Terminal({
    theme: { background: "#161619", foreground: "rgba(237, 237, 239, 0.55)" },
    fontFamily: mono,
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

  // Fit BEFORE starting so the PTY is created at its final size. Otherwise the
  // shell prints a prompt at 80x24, then the post-start resize fires SIGWINCH
  // and it reprints — the doubled prompt. (fitTab won't send a resize here:
  // the tab isn't "running" yet.) Re-fit after paint to correct any pre-layout
  // miscalc; the resize guard makes that a no-op if the size is unchanged.
  fitTab(tabId);
  if (_ws?.readyState === WebSocket.OPEN) _sendStart(tabId);
  requestAnimationFrame(() => fitTab(tabId));
}

/** Called by TabStage's cleanup effect before the host divs are removed. */
export function unmountTab(tabId) {
  const rec = _terms.get(tabId);
  if (!rec) return;
  rec.ro?.disconnect();
  rec.main.dispose();
  rec.mirror?.dispose();
  _terms.delete(tabId);
}

/**
 * Mount a single live xterm for a backend-owned pipeline node session.
 * Unlike mountTab there is no mirror view: the node box in the dashboard is
 * itself the live terminal. The session already exists server-side (created by
 * the PipelineEngine), so we attach to it for replay + live output rather than
 * sending a "start".
 */
export function mountNodeTerm(tabId, host, agentNodeId = null) {
  if (_terms.has(tabId)) { fitTab(tabId); return; } // already mounted
  const tab = _state.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const mono = '"SF Mono", "JetBrains Mono", ui-monospace, "Menlo", monospace';
  const main = new Terminal({
    theme: {
      background: "#0e0e10",
      foreground: "#ededef",
      cursor: "#7c6cff",
      cursorAccent: "#0e0e10",
      selectionBackground: "rgba(124, 108, 255, 0.30)",
    },
    fontFamily: mono,
    fontSize: 12, cursorBlink: true,
  });
  const mainFit = new FitAddon();
  main.loadAddon(mainFit);
  main.open(host);

  let _line = "";
  main.onData((data) => {
    if (agentNodeId) {
      // Interactive coordinator terminal: a virtual session has no PTY to echo
      // or receive stdin, so echo locally and send the whole line to the agent
      // (its inbox) on Enter — so it behaves like a classic terminal.
      if (data.startsWith("\x1b")) return; // ignore arrow keys / escape seqs
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          main.write("\r\n");
          // tabId is `${workspaceId}::node-${nodeId}` — route to the right run.
          if (_line.trim()) sendNodeInput(tabId.split("::")[0], agentNodeId, _line);
          _line = "";
        } else if (ch === "\x7f" || ch === "\b") {
          if (_line.length) { _line = _line.slice(0, -1); main.write("\b \b"); }
        } else if (ch >= " ") {
          _line += ch;
          main.write(ch);
        }
      }
      return;
    }
    const t = _state.tabs.find((x) => x.id === tabId);
    if (t?.sessionId) _send({ type: "stdin", id: t.sessionId, data: strToB64(data) });
  });

  // Refit (and resize the PTY) whenever the card's width changes — wrapping,
  // window resize, or layout settling — so the xterm fits its column.
  const ro = new ResizeObserver(() => fitTab(tabId));
  ro.observe(host);

  // Register before attaching so replay/stdout has a terminal to write to.
  _terms.set(tabId, { main, mirror: null, mainFit, mirrorFit: null, ro });

  if (tab.sessionId) _send({ type: "attach", id: tab.sessionId });
  fitTab(tabId);
  requestAnimationFrame(() => fitTab(tabId));
}


// ── workspace ("session") actions ────────────────────────────────────────────
export function createWorkspace(dir, name) {
  _send({ type: "create_workspace", dir, name });
}

export function deleteWorkspace(wid) {
  cancelWorkspace(wid);
  _clearWorkspaceNodeTabs(wid);
  _send({ type: "delete_workspace", workspace_id: wid });
}

export function selectWorkspace(wid) {
  _setState({ activeWorkspaceId: wid });
  setTimeout(refitNodes, 0); // the now-visible workspace's node terminals
}

export function setWorkspaceDsl(wid, dsl) {
  // Local edit is the editor's source of truth; persist it to the server.
  _patchWorkspace(wid, { dsl });
  _send({ type: "set_pipeline", workspace_id: wid, dsl });
}

export function runWorkspace(wid, spec, backend = "bare") {
  // Attach the parsed spec so the live tree renders once "pipeline_started"
  // arrives. `backend` selects the node backend ("bare" plain PTY, or "tmux").
  _patchWorkspace(wid, { spec });
  _send({ type: "run_workspace", workspace_id: wid, pipeline: spec, backend });
}

export function cancelWorkspace(wid) {
  // Server cancels the run, kills in-flight child PTYs, emits "pipeline_error".
  _send({ type: "cancel_workspace", workspace_id: wid });
}

/** Steer a running coordinator agent — routed to its inbox by (workspace, node). */
export function sendNodeInput(workspaceId, nodeId, text) {
  _send({ type: "node_input", workspace_id: workspaceId, node_id: nodeId, text });
}

/** Launch a session in the real macOS Terminal. The server's active backend
 *  decides the semantics: a true tmux re-attach, or a fresh shell at the
 *  session's working directory under the bare backend. */
export function openInTerminal(sessionId) {
  if (sessionId) _send({ type: "open_in_terminal", id: sessionId });
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

/**
 * Keep the mirror as a faithful read-only copy: give it the SAME grid
 * (cols/rows) as the main terminal so cursor-addressing escapes render
 * identically (no smearing on resize), then CSS-scale the whole element down
 * to fit the narrow mirror pane. Scaling (not re-fitting to a different width)
 * is what makes it corruption-proof.
 */
function _syncMirror(rec) {
  if (!rec.mirror) return;
  if (rec.mirror.cols !== rec.main.cols || rec.mirror.rows !== rec.main.rows) {
    try { rec.mirror.resize(rec.main.cols, rec.main.rows); } catch (_) {}
  }
  const el = rec.mirror.element;
  const host = el && el.parentElement;
  if (!el || !host) return;
  el.style.transformOrigin = "top left";
  el.style.transform = "none";          // reset to measure natural width
  const naturalW = el.offsetWidth || 1;
  const avail = host.clientWidth || naturalW;
  el.style.transform = `scale(${Math.min(1, avail / naturalW)})`;
}

export function fitTab(tabId) {
  const rec = _terms.get(tabId);
  if (!rec) return;
  try {
    rec.mainFit.fit();
    _syncMirror(rec);
    const tab = _state.tabs.find((t) => t.id === tabId);
    if (tab?.sessionId && tab.status === "running") {
      const { cols, rows } = rec.main;
      // Only resize when the geometry actually changed: a redundant resize
      // still fires SIGWINCH, which makes the shell reprint its prompt
      // (the duplicate-prompt artifact, most visible in the mirror).
      if (rec._lastCols !== cols || rec._lastRows !== rows) {
        rec._lastCols = cols;
        rec._lastRows = rows;
        _send({ type: "resize", id: tab.sessionId, cols, rows });
      }
    }
  } catch (_) {}
}

export function fitActive() {
  if (_state.activeTabId) fitTab(_state.activeTabId);
}

/** Refit every mounted pipeline node terminal — used when the pipeline view
 *  becomes visible again after being display:none. */
export function refitNodes() {
  for (const tabId of _terms.keys()) {
    if (tabId.includes("::node-")) fitTab(tabId);
  }
}

// ── useSyncExternalStore API ─────────────────────────────────────────────────
export function subscribe(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

export function getSnapshot() { return _state; }

// ── bootstrap ────────────────────────────────────────────────────────────────
_connect();
