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

// Fixed grid for shared node terminals — must match the node session size the
// backend creates (PipelineEngine/TerminalNode: 80x24). Node terminals render
// at this size and never resize the PTY, so multiple simultaneous viewers (card,
// Share view, other windows) can't fight over the width and scramble a TUI.
const NODE_COLS = 80;
const NODE_ROWS = 24;

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
let _autoTerm = false;  // have we auto-created the first interactive terminal?

// Node-card tab id, namespaced per workspace so the same node id (n0, n1/0, …)
// in two concurrent workspaces never collides in the tabs list or _terms map.
function _nodeTabId(wid, nodeId) { return `${wid}::node-${nodeId}`; }

function _blankRunState() {
  return {
    status: "idle", spec: null, statusById: {}, sessionById: {},
    childrenByParent: {}, outputs: {}, result: null,
    // itr loop badge state: node_id -> { current, max, complete }
    iterById: {},
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
    // One sync hands this window the SHARED terminal + workspace lists and
    // replays any running pipelines, so it mirrors the other windows.
    _send({ type: "sync" });
    // Reconnect: re-subscribe any already-mounted terminals (reset first so the
    // replay doesn't duplicate what's already on screen).
    for (const tabId of _terms.keys()) {
      const tab = _state.tabs.find((t) => t.id === tabId && !t.isNode);
      if (tab?.sessionId) { _terms.get(tabId).main.reset(); _send({ type: "attach", id: tab.sessionId }); }
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
  if (node.body && _subtreeHasNode(node.body, nodeId)) return true; // itr loop body
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
    case "terminal_list": {
      // The shared set of interactive terminals (mirrored across windows).
      // Interactive tab id === its session id; node tabs are kept as-is.
      const serverTerms = msg.terminals || [];
      const serverIds = new Set(serverTerms.map((t) => t.id));
      const prevIds = new Set(_state.tabs.filter((t) => !t.isNode).map((t) => t.id));
      // Drop routing for terminals that went away (their TabStage unmounts).
      for (const t of _state.tabs) {
        if (!t.isNode && !serverIds.has(t.id)) _bySession.delete(t.id);
      }
      const interactive = serverTerms.map((t) => ({
        id: t.id, title: t.title, sessionId: t.id, status: "running", isNode: false,
      }));
      const nodeTabs = _state.tabs.filter((t) => t.isNode);
      // Auto-select a newly-appeared terminal; else keep the current active if
      // still present, else fall back to the last terminal.
      const newId = serverTerms.find((t) => !prevIds.has(t.id))?.id;
      let active = newId || _state.activeTabId;
      const allIds = new Set([...serverIds, ...nodeTabs.map((t) => t.id)]);
      if (!allIds.has(active)) active = interactive[interactive.length - 1]?.id ?? null;
      _setState({ tabs: [...interactive, ...nodeTabs], activeTabId: active });
      // First window with no terminals: open one (broadcasts to all windows).
      if (serverTerms.length === 0 && !_autoTerm) {
        _autoTerm = true;
        _send({ type: "create_terminal", cols: 80, rows: 24 });
      }
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
      // Use the broadcast spec so EVERY window (and a synced one) can render the
      // live tree, not just the window that clicked Run. Fall back to local spec.
      _patchWorkspace(wid, (w) => ({ ..._blankRunState(), spec: msg.spec || w.spec, status: "running" }));
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
      if (msg.node_type === "iteration" && wid) {
        // The loop container itself: seed its badge state and mark it running.
        _patchWorkspace(wid, (w) => ({
          statusById: { ...w.statusById, [msg.node_id]: "running" },
          iterById: { ...(w.iterById || {}), [msg.node_id]: { current: 0, max: msg.max_iterations, complete: false } },
          currentStage: _stageContaining(w.spec, msg.node_id) || w.currentStage,
        }));
        break;
      }
      if (msg.node_type === "terminal" && !msg.internal && wid) {
        const nodeId = msg.node_id;
        const parentId = msg.node_id != null ? msg.parent_id : null;
        const tabId = _nodeTabId(wid, nodeId);
        const existing = _state.tabs.find((t) => t.id === tabId);
        if (!existing) {
          const tab = { id: tabId, title: `Job ${nodeId}`, sessionId: msg.id, status: "running", isNode: true, workspaceId: wid, nodeId };
          _bySession.set(msg.id, tabId);
          _setState({ tabs: [..._state.tabs, tab] });
        } else if (existing.sessionId !== msg.id) {
          // Same node id, NEW session = the next itr pass. Re-point the tab to the
          // fresh session and re-attach its terminal (reset so the pass paints clean).
          _bySession.delete(existing.sessionId);
          _bySession.set(msg.id, tabId);
          _patchTab(tabId, { sessionId: msg.id, status: "running" });
          _reattachNode(tabId, msg.id);
        }
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
    case "iteration_started": {
      const wid = msg.workspace_id;
      if (msg.node_id == null || !wid) break;
      _patchWorkspace(wid, (w) => ({
        iterById: { ...(w.iterById || {}), [msg.node_id]: { current: msg.iteration, max: msg.max_iterations, complete: false } },
      }));
      break;
    }
    case "iteration_finished": {
      const wid = msg.workspace_id;
      if (msg.node_id == null || !wid) break;
      _patchWorkspace(wid, (w) => ({
        iterById: { ...(w.iterById || {}), [msg.node_id]: { ...(w.iterById?.[msg.node_id] || {}), complete: msg.complete } },
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
    case "node_attached": {
      // Reply to a shared deep-link's attach_node: wire the focused xterm to the
      // resolved session and paint its replay.
      const key = `shared::${msg.workspace_id}::${msg.node_id}`;
      const rec = _terms.get(key);
      if (!rec) break;
      if (msg.error) { rec.main.write(`\r\n[${msg.error}]\r\n`); break; }
      rec._agent = !!msg.agent;       // coordinator (line input) vs PTY (raw stdin)
      rec._sessionId = msg.id;
      _bySession.set(msg.id, key);    // route live stdout/exit to this terminal
      try { rec.main.resize(msg.cols || 80, msg.rows || 24); } catch (_) {}
      if (msg.data) rec.main.write(b64dec(msg.data));
      break;
    }
    case "error":
      console.warn("[ws] server error:", msg.message);
      break;
  }
}

// ── tab lifecycle ────────────────────────────────────────────────────────────

export function newTab() {
  // Server-driven + shared: create_terminal broadcasts terminal_list, so the
  // new tab appears (and attaches) in EVERY window; auto-selected here on arrival.
  _send({ type: "create_terminal", cols: 80, rows: 24 });
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

  _terms.set(tabId, { main, mirror, mainFit, mirrorFit });
  // Interactive tab id === its (server-created) session id. Attach to it —
  // terminals are shared/server-owned now, so we mirror rather than spawn.
  _bySession.set(tabId, tabId);
  fitTab(tabId);
  if (_ws?.readyState === WebSocket.OPEN) _send({ type: "attach", id: tabId });
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
/** Re-point an already-mounted node terminal to a fresh session (the next itr
 *  pass): reset the grid so the new pass paints clean, then attach. If it isn't
 *  mounted yet, do nothing — mountNodeTerm attaches to the tab's updated id. */
function _reattachNode(tabId, sessionId) {
  const rec = _terms.get(tabId);
  if (!rec) return;
  try { rec.main?.reset(); } catch (_) { /* terminal not open */ }
  _send({ type: "attach", id: sessionId });
}

export function mountNodeTerm(tabId, host, agentNodeId = null) {
  if (_terms.has(tabId)) return; // already mounted; fixed grid needs no refit
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
  main.open(host);
  // Pinned grid (see NODE_COLS): a node session is shared by several viewers at
  // once (its card, the focused Share view, other windows). If each fit its own
  // width and resized the one shared PTY, they'd fight over its size and an
  // interactive TUI's cursor-addressed output would land at the wrong columns
  // (the scrambled text). So render at the session's fixed size and never resize
  // the PTY — every viewer sees the same grid. A narrower card clips it; the
  // larger Share view shows it with margin.
  try { main.resize(NODE_COLS, NODE_ROWS); } catch (_) { /* not laid out yet */ }

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

  // Register before attaching so replay/stdout has a terminal to write to.
  // No FitAddon/ResizeObserver: the grid is fixed and the PTY is never resized.
  _terms.set(tabId, { main, mirror: null, mainFit: null, mirrorFit: null, ro: null });

  if (tab.sessionId) _send({ type: "attach", id: tab.sessionId });
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

// ── shared node deep-link ────────────────────────────────────────────────────
export function shareLink(workspaceId, nodeId) {
  return `${location.origin}/shared/workspace/${workspaceId}/t/${nodeId}`;
}

export function copyShareLink(workspaceId, nodeId) {
  return navigator.clipboard.writeText(shareLink(workspaceId, nodeId));
}

/** Focused single-node terminal for the /shared/... route: attach to the node's
 *  live session (resolved server-side via the workspace's run), mirror its
 *  output, and drive its input (coordinator inbox or raw PTY stdin). */
export function mountSharedNode(workspaceId, nodeId, host) {
  const key = `shared::${workspaceId}::${nodeId}`;
  if (_terms.has(key)) return key;

  const mono = '"SF Mono", "JetBrains Mono", ui-monospace, "Menlo", monospace';
  const main = new Terminal({
    theme: {
      background: "#0e0e10", foreground: "#ededef",
      cursor: "#7c6cff", cursorAccent: "#0e0e10",
      selectionBackground: "rgba(124, 108, 255, 0.30)",
    },
    fontFamily: mono, fontSize: 13, cursorBlink: true,
  });
  main.open(host);

  let _line = "";
  main.onData((data) => {
    const rec = _terms.get(key);
    if (!rec) return;
    if (rec._agent) {
      // Coordinator: no PTY echo — local echo + send the line to its inbox.
      if (data.startsWith("\x1b")) return;
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          main.write("\r\n");
          if (_line.trim()) sendNodeInput(workspaceId, nodeId, _line);
          _line = "";
        } else if (ch === "\x7f" || ch === "\b") {
          if (_line.length) { _line = _line.slice(0, -1); main.write("\b \b"); }
        } else if (ch >= " ") { _line += ch; main.write(ch); }
      }
      return;
    }
    if (rec._sessionId) _send({ type: "stdin", id: rec._sessionId, data: strToB64(data) });
  });

  // We don't resize the shared session (it's owned by the run) — fix the grid to
  // the session size on attach instead, so we never SIGWINCH the live node.
  _terms.set(key, { main, mirror: null, mainFit: null, mirrorFit: null, _agent: false, _sessionId: null });
  _send({ type: "attach_node", workspace_id: workspaceId, node_id: nodeId });
  return key;
}

export function activateTab(tabId) {
  _setState({ activeTabId: tabId });
  // Refit after the new tab's hosts become visible (next microtask).
  setTimeout(() => fitTab(tabId), 0);
}

export function closeTab(tabId) {
  // Shared: close_terminal kills the session and broadcasts the new list, so the
  // tab disappears from every window (state updated when terminal_list arrives).
  const tab = _state.tabs.find((t) => t.id === tabId);
  if (tab?.sessionId) _send({ type: "close_terminal", id: tab.sessionId });
}

export function restartTab(tabId) {
  const tab = _state.tabs.find((t) => t.id === tabId);
  if (tab?.sessionId) _send({ type: "restart_terminal", id: tab.sessionId });
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
