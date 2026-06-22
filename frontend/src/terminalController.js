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
import { APP_FX_TYPES } from "./appFx.js";
import { parseDsl } from "./pipelineDsl.js";

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
  workspaces: [],       // [{ id, name, dir, dsl, kind, meta, status, spec, statusById, sessionById, childrenByParent, outputs, result, warnings, error, currentStage }]
  activeWorkspaceId: null,
  // Decoupled tab order: [workspace_id] from the backend's WorkspaceOrder store,
  // reconciled against the live list. Drives tab order; Workspace has no order field.
  workspaceOrder: [],
  // Workspace-kind manifest from the server: [{ id, label, fields }]. Drives the
  // create modal kind-agnostically (a new backend kind appears with no UI change).
  kinds: [],
  // Set when a worktree removal was refused (e.g. dirty tree) so the close dialog
  // can offer Force: { workspaceId, message }. Cleared once that workspace closes.
  closeBlocked: null,
  // Transient error/notice toasts: [{ id, message, kind }]. Auto-dismiss.
  toasts: [],
  // github.pulls subdomain: the viewer's open PR inbox (raised/assigned/review),
  // refreshed on every socket (re)connect + manual refresh.
  prs: [],
  prsViewer: null,
  prsLoading: false,
  prsError: null,
  prsUpdatedAt: null,
  // repos domain: local owner/name -> path index + configured roots. Broadcast on
  // connect; drives the repos dropdown and resolving a PR to its local checkout.
  repos: [],
  repoRoots: [],
  // slack domain: connection state + channel list (the token lives server-side
  // only — never sent to the client). slackMessages/slackMentions hold the latest
  // fetch for the Slack tab.
  slack: { configured: false, channels: [], polled: [], multiplexers: [], teamUrl: "" },
  slackMessages: {},   // channel id -> recent messages (open-channel load + poller)
  slackMentions: [],
  // automations domain: user rules that turn domain events into actions (today:
  // a new PR -> a worktree workspace running a pipeline). `automationKinds` is the
  // backend manifest that drives the rule editor generically. Evaluated on the
  // frontend (see _evaluatePrAutomations) and broadcast so every window agrees.
  automations: [],
  automationKinds: [],
  // CI/CD domain → TeamCity subdomain: connection state + live recent-build feed.
  // The token/OAuth secret live server-side only (never sent to the client).
  cicd: { teamcity: { configured: false, connected: false, url: "", hasToken: false,
                      hasOauthClient: false, hasCreds: false, builds: [], projects: [], error: null } },
  teamcityProjectBuilds: {},   // projectId -> recent builds (on-demand, picker selection)
  teamcityBranchBuilds: {},    // branch -> recent builds (poller-fed; per-workspace branch panel)
  // Active whole-app animations: [{ type, key }]. Several can run at once so a
  // view/action can fire a combination of effects. <AppFx/> renders each.
  appFx: [],
  // Create-workspace modal: null = closed; { kind?, fields? } = open (optionally
  // pre-filled, e.g. from a /pipeline/new-workspace deep-link or a PR action).
  newWorkspace: null,
};

let _fxSeq = 0;

let _toastSeq = 0;
function _pushToast(message, kind = "error") {
  const id = ++_toastSeq;
  _setState({ toasts: [..._state.toasts, { id, message, kind }] });
  setTimeout(() => {
    if (_state.toasts.some((t) => t.id === id)) {
      _setState({ toasts: _state.toasts.filter((t) => t.id !== id) });
    }
  }, 7000);
}

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
    // Fetch the GitHub PR inbox on every (re)connect, so the data is fresh
    // whenever the socket establishes — not just when the PR view is opened.
    listPrs();
    // Re-register any open branch panels — the backend's watched set is in-memory
    // and is lost across a server restart/reconnect.
    if (_branchWatchers.size) _sendWatchedBranches();
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
      // Workspaces removed (here or by another window): drop their node-card tabs.
      for (const id of existing.keys()) {
        if (!defs.find((d) => d.id === id)) _clearWorkspaceNodeTabs(id);
      }
      const merged = defs.map((d) =>
        existing.has(d.id)
          ? { ...existing.get(d.id), name: d.name, dir: d.dir, kind: d.kind, meta: d.meta, closing: d.closing }
          : { id: d.id, name: d.name, dir: d.dir, dsl: d.dsl || "", kind: d.kind || "directory", meta: d.meta || {}, closing: d.closing, ..._blankRunState() }
      );
      let active = msg.created || _state.activeWorkspaceId;
      if (!merged.find((w) => w.id === active)) active = merged[0]?.id ?? null;
      // Clear a stale block once its workspace is gone.
      const blocked = _state.closeBlocked && merged.find((w) => w.id === _state.closeBlocked.workspaceId)
        ? _state.closeBlocked : null;
      _setState({ workspaces: merged, activeWorkspaceId: active, kinds: msg.kinds || _state.kinds,
                  closeBlocked: blocked, workspaceOrder: msg.order || [] });
      break;
    }
    case "workspace_cleanup_blocked": {
      // A worktree removal was refused (dirty tree). Surface it so the close
      // dialog can offer Force; the workspace stays until resolved.
      _setState({ closeBlocked: { workspaceId: msg.workspace_id, message: msg.message } });
      break;
    }
    case "repos": {
      _setState({ repos: msg.repos || [], repoRoots: msg.roots || [] });
      break;
    }
    case "slack": {
      _setState({ slack: { configured: !!msg.configured, channels: msg.channels || [], polled: msg.polled || [], multiplexers: msg.multiplexers || [], teamUrl: msg.teamUrl || "" } });
      break;
    }
    case "slack_messages": {
      _setState({ slackMessages: { ..._state.slackMessages, [msg.channel]: msg.messages || [] } });
      break;
    }
    case "slack_mentions": {
      _setState({ slackMentions: msg.mentions || [] });
      break;
    }
    case "slack_sent": {
      if (!msg.ok) _pushToast(`Slack: ${msg.error || "send failed"}`);
      break;
    }
    case "prs": {
      const prs = msg.prs || [];
      _setState({
        prs,
        prsViewer: msg.viewer ?? _state.prsViewer,
        prsError: msg.error || null,
        prsLoading: false,
        prsUpdatedAt: Date.now(),
      });
      _evaluatePrAutomations(prs);
      break;
    }
    case "automations": {
      _setState({ automations: msg.rules || [], automationKinds: msg.kinds || [] });
      break;
    }
    case "cicd": {
      _setState({ cicd: { teamcity: msg.teamcity || {} } });
      break;
    }
    case "teamcity_project_builds": {
      _setState({ teamcityProjectBuilds: { ..._state.teamcityProjectBuilds, [msg.projectId]: msg.builds || [] } });
      break;
    }
    case "teamcity_branch_builds": {
      const key = teamcityBranchKey(msg.repo, msg.branch);
      _setState({ teamcityBranchBuilds: { ..._state.teamcityBranchBuilds, [key]: msg.builds || [] } });
      break;
    }
    case "workspace_ensured": {
      // Background get-or-create ack from an automation; focus/selection (when
      // requested) rides on the workspace_list broadcast, so nothing to do here.
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
    case "pipeline_cancelled": {
      // Deliberate stop (Cancel / closing) — neutral, not an error banner.
      _patchWorkspace(msg.workspace_id, { status: "cancelled", error: null });
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
      _pushToast(msg.message);
      break;
    case "notice":
      _pushToast(msg.message, "info");
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


// ── automations (PR → workspace, evaluated frontend-side) ────────────────────
// We diff each PR refresh against a seen-set so a rule fires once per NEW PR.
// The set is seeded silently on the first refresh after (re)connect, so we never
// act on the pre-existing backlog — only PRs that appear afterwards.
let _seenPrKeys = null;

function _prKey(pr) { return pr.id || `${pr.repo}#${pr.number}`; }

/** The local checkout path for a PR's repo, or null (can't worktree without one). */
function _repoPathForPr(pr) {
  const local = (_state.repos || []).find(
    (r) => (r.name || "").toLowerCase() === (pr.repo || "").toLowerCase());
  return local ? local.path : null;
}

/** Does an active "pr"-kind rule match this PR? (blank filter = match any). */
function _ruleMatchesPr(rule, pr) {
  if (!rule.active || rule.kind !== "pr") return false;
  const m = rule.match || {};
  const author = (m.author || "").trim().toLowerCase();
  const repo = (m.repo || "").trim().toLowerCase();
  if (author && !(pr.author || "").toLowerCase().includes(author)) return false;
  if (repo && !(pr.repo || "").toLowerCase().includes(repo)) return false;
  return true;
}

/** On each PR refresh: for every genuinely-new PR matched by an active rule, ask
 *  the backend to get-or-create a worktree workspace on its branch and run the
 *  rule's pipeline spec (in the background — no focus steal). Idempotent end to
 *  end: the seen-set guards re-sends here, the backend dedupes by repo+branch. */
function _evaluatePrAutomations(prs) {
  if (_seenPrKeys === null) {        // first refresh: remember, trigger nothing
    _seenPrKeys = new Set(prs.map(_prKey));
    return;
  }
  const rules = (_state.automations || []).filter((r) => r.active && r.kind === "pr");
  for (const pr of prs) {
    const key = _prKey(pr);
    if (_seenPrKeys.has(key)) continue;
    _seenPrKeys.add(key);
    if (!rules.length) continue;
    const rule = rules.find((r) => _ruleMatchesPr(r, pr));
    if (!rule) continue;
    const repoPath = _repoPathForPr(pr);
    if (!repoPath) continue;         // no local checkout registered for this repo
    _send({
      type: "ensure_workspace",
      kind: "worktree",
      fields: { dir: repoPath, name: pr.headRefName || `pr-${pr.number}` },
      pipeline: parseDsl(rule.spec || ""),
      dsl: rule.spec || "",
      meta: { pr: `${pr.repo}#${pr.number}`, automation: rule.id },
      focus: false,
    });
  }
}

/** Persist a rule (create when it has no id, else update). */
export function saveAutomation(rule) { _send({ type: "save_automation", rule }); }

export function deleteAutomation(id) { _send({ type: "delete_automation", id }); }

// ── CI/CD domain → TeamCity subdomain ────────────────────────────────────────
export function setTeamCityConfig({ url, token, clientId, clientSecret }) {
  _send({ type: "set_teamcity_config", url, token, clientId, clientSecret });
}
/** Kick off the Google IAP browser consent (opens a tab on this machine). */
export function connectTeamCity() { _send({ type: "connect_teamcity" }); }
export function refreshTeamCity() { _send({ type: "teamcity_refresh" }); }
export function loadTeamCityProjectBuilds(projectId) { if (projectId) _send({ type: "teamcity_project_builds", projectId }); }

// A branch panel is identified by (repo, branch) — Dependabot reuses the same
// branch name across repos, so the repo scopes it. Panels are ref-counted: N
// mounted panels for the same (repo, branch) keep it in the backend poller's
// watched set exactly once; it drops out when the last unmounts (no leak).
export function teamcityBranchKey(repo, branch) { return `${repo || ""} ${branch || ""}`; }
const _branchWatchers = new Map();   // key -> { count, repo, branch }
function _sendWatchedBranches() {
  _send({ type: "teamcity_set_watched_branches",
          branches: [..._branchWatchers.values()].map(({ repo, branch }) => ({ repo, branch })) });
}
export function watchTeamCityBranch(repo, branch) {
  if (!branch) return;
  const key = teamcityBranchKey(repo, branch);
  const e = _branchWatchers.get(key);
  if (e) { e.count += 1; }
  else { _branchWatchers.set(key, { count: 1, repo, branch }); _sendWatchedBranches(); }
}
export function unwatchTeamCityBranch(repo, branch) {
  if (!branch) return;
  const key = teamcityBranchKey(repo, branch);
  const e = _branchWatchers.get(key);
  if (!e) return;
  e.count -= 1;
  if (e.count <= 0) { _branchWatchers.delete(key); _sendWatchedBranches(); }
}
export function triggerTeamCityBuild(buildTypeId, branch) { _send({ type: "teamcity_trigger", buildTypeId, branch }); }
export function cancelTeamCityBuild(buildId, state) { _send({ type: "teamcity_cancel", buildId, state }); }
export function rerunTeamCityBuild(buildId) { _send({ type: "teamcity_rerun", buildId }); }

// ── workspace actions ────────────────────────────────────────────────────────
/** Create a workspace of `kind` (e.g. "directory" | "worktree") from the modal's
 *  field values. The backend's kind adapter provisions the working dir. */
export function createWorkspace(kind, fields) {
  _send({ type: "create_workspace", kind, fields });
}

export function deleteWorkspace(wid, opts = {}) {
  // Server-authoritative: it cancels the run, optionally tears down resources
  // (opts.remove_resources / opts.force), and broadcasts the new list — which is
  // where this window drops the workspace's node tabs. A dirty worktree removal
  // is refused and replies with workspace_cleanup_blocked (the workspace stays).
  _send({ type: "delete_workspace", workspace_id: wid, ...opts });
}

/** Dismiss a pending removal block (e.g. the user cancelled the close dialog). */
export function clearCloseBlocked() {
  if (_state.closeBlocked) _setState({ closeBlocked: null });
}

/** Dismiss a toast by id (click-to-close). */
export function dismissToast(id) {
  _setState({ toasts: _state.toasts.filter((t) => t.id !== id) });
}

// ── whole-app FX ─────────────────────────────────────────────────────────────
/** Play a whole-app animation by type (see appFx.js). Adds it to the active set
 *  (so combinations run concurrently) with a fresh key; auto-removes after the
 *  type's duration. */
export function playAppFx(type) {
  const cfg = APP_FX_TYPES[type];
  if (!cfg) return;
  const key = ++_fxSeq;
  _setState({ appFx: [..._state.appFx, { type, key }] });
  setTimeout(() => {
    _setState({ appFx: _state.appFx.filter((f) => f.key !== key) });
  }, cfg.duration);
}

// ── create-workspace modal ───────────────────────────────────────────────────
/** Open the create-workspace modal, optionally pre-filled: { kind, fields }. */
export function openNewWorkspace(prefill) {
  _setState({ newWorkspace: prefill || {} });
}
export function closeNewWorkspace() {
  if (_state.newWorkspace) _setState({ newWorkspace: null });
}

// ── repos ────────────────────────────────────────────────────────────────────
/** Set the local-repo scan roots (persisted server-side, then re-indexed). */
export function setRepoRoots(roots) {
  _send({ type: "set_repo_roots", roots });
}
/** Re-scan the roots for local repos. */
export function refreshRepos() {
  _send({ type: "refresh_repos" });
}

// ── github.pulls ─────────────────────────────────────────────────────────────
/** Request the viewer's open PR inbox (raised / assigned / review-requested).
 *  Called on every socket (re)connect and by the manual refresh button. */
export function listPrs() {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _setState({ prsLoading: true });
    _send({ type: "list_prs" });
  }
}

// ── slack ────────────────────────────────────────────────────────────────────
/** Set the Slack token (bot xoxb- or user xoxp-). Stored server-side only;
 *  the broadcast back carries just {configured, channels}, never the token. */
export function setSlackToken(token, cookie = "") {
  _send({ type: "set_slack_token", token, cookie });
}
/** Store OAuth app creds for the "Add to Slack" flow (Client ID/Secret + the
 *  redirect URL registered in the Slack app). */
export function setSlackApp(clientId, clientSecret, redirectUri) {
  _send({ type: "set_slack_app", client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
}
/** Set the channels the backend poller watches for real-time updates. */
export function setSlackPolled(channels) {
  _send({ type: "set_slack_polled", channels });
}
/** Set the read-only merge views [{id, name, channels}] (frontend merges; the
 *  server persists them + folds their channels into the poll set). */
export function setSlackMultiplexers(multiplexers) {
  _send({ type: "set_slack_multiplexers", multiplexers });
}
/** Re-fetch the channel list. */
export function refreshSlack() {
  _send({ type: "refresh_slack" });
}
/** Load a channel's recent messages (-> slack_messages state). */
export function loadSlackMessages(channel, limit = 30) {
  if (channel) _send({ type: "slack_channel_messages", channel, limit });
}
/** Load your recent mentions (needs a user token with search:read). */
export function loadSlackMentions() {
  _send({ type: "slack_mentions" });
}
/** Post a message to a channel. */
export function sendSlackMessage(channel, text) {
  if (channel && (text || "").trim()) _send({ type: "slack_send", channel, text });
}

export function selectWorkspace(wid) {
  _setState({ activeWorkspaceId: wid });
  setTimeout(refitNodes, 0); // the now-visible workspace's node terminals
}

/** Persist a new tab order (decoupled from the Workspace model). The server
 *  stores + broadcasts it, so every window and a reload reflect the order. */
export function setWorkspaceOrder(order) {
  _send({ type: "set_workspace_order", order });
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

/** Read a node terminal's current on-screen rows as plain strings — for the 3D
 *  world's in-room screens. Uses the live xterm we already keep mounted (fed by
 *  the existing stdout stream), so it's fully decoupled: no backend call, no extra
 *  state. Returns null if that terminal isn't mounted yet. */
// Standard ANSI 16-colour palette (xterm-ish), then the 6×6×6 cube and greys.
const ANSI16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];
function ansi256(i) {
  if (i < 16) return ANSI16[i];
  if (i < 232) {
    const n = i - 16, q = (x) => (x ? x * 40 + 55 : 0);
    return `rgb(${q(Math.floor(n / 36))},${q(Math.floor((n % 36) / 6))},${q(n % 6)})`;
  }
  const l = (i - 232) * 10 + 8;
  return `rgb(${l},${l},${l})`;
}
const rgbHex = (v) => `#${(v & 0xffffff).toString(16).padStart(6, "0")}`;
function cellColor(cell, bg) {
  if (bg) {
    if (cell.isBgDefault()) return null;
    return cell.isBgRGB() ? rgbHex(cell.getBgColor()) : ansi256(cell.getBgColor());
  }
  if (cell.isFgDefault()) return null;
  return cell.isFgRGB() ? rgbHex(cell.getFgColor()) : ansi256(cell.getFgColor());
}

/** Read a node terminal's visible grid as styled runs for the 3D screen mirror.
 *  Each row is an array of {t, fg, bg, bold} spans (fg/bg = CSS colour or null
 *  for the terminal default). Colour comes straight from xterm's cell buffer.
 *  Reads from the current viewport top so the mirror follows the scrollback. */
export function readNodeScreen(tabId) {
  const term = _terms.get(tabId)?.main;
  if (!term) return null;
  const buf = term.buffer.active;
  const top = buf.viewportY;          // current viewport top (follows scrollback)
  const rows = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(top + y);
    const spans = [];
    if (line) {
      let cur = null;
      for (let x = 0; x < term.cols; x++) {
        const c = line.getCell(x);
        if (!c || c.getWidth() === 0) continue;   // skip placeholder after a wide char
        const inv = c.isInverse();
        const fg0 = cellColor(c, false), bg0 = cellColor(c, true);
        const fg = inv ? (bg0 || "#07140d") : fg0;
        const bg = inv ? (fg0 || "#cdd6d0") : bg0;
        const bold = c.isBold() ? 1 : 0;
        const t = c.getChars() || " ";
        if (cur && cur.fg === fg && cur.bg === bg && cur.bold === bold) cur.t += t;
        else { cur = { t, fg, bg, bold }; spans.push(cur); }
      }
    }
    rows.push(spans);
  }
  return { rows, cols: term.cols, cursorX: buf.cursorX, cursorY: buf.cursorY + (buf.baseY - top) };
}

/** Scroll a node terminal by forwarding a wheel delta to its native scroll element
 *  (.xterm-viewport) — the same path the on-screen pipeline view uses. The terminal
 *  must be RENDERED (the WorldView overlay keeps it on-screen behind the modal) for
 *  the viewport to have scroll height; falls back to scrollLines otherwise. */
export function scrollNodeTerminal(tabId, deltaY) {
  const term = _terms.get(tabId)?.main;
  if (!term || !deltaY) return;
  const vp = term.element?.querySelector(".xterm-viewport");
  if (vp) vp.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
  else term.scrollLines(Math.sign(deltaY) * Math.max(1, Math.round(Math.abs(deltaY) / 40)));
}

/** Route raw bytes to a node terminal's PTY — the same path the live xterm's
 *  onData uses. Powers WorldView's in-world typing. Returns true if delivered. */
export function sendTerminalInput(tabId, data) {
  const tab = _state.tabs.find((t) => t.id === tabId);
  if (!tab?.sessionId) return false;
  _send({ type: "stdin", id: tab.sessionId, data: strToB64(data) });
  return true;
}

// ── useSyncExternalStore API ─────────────────────────────────────────────────
export function subscribe(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

export function getSnapshot() { return _state; }

// ── bootstrap ────────────────────────────────────────────────────────────────
_connect();
