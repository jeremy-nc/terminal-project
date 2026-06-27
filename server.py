"""Browser terminal server.

Spawns real PTYs, streams them over WebSockets, keeps a per-session ring
buffer for late-join replay, and cleans up child processes on disconnect /
shutdown. See PROTOCOL below for the WebSocket message contract.

PROTOCOL (JSON, both directions)
  client -> server:
    {type:"start",  shell, cols, rows, cid}  open a new PTY session (cid: client correlation id, echoed back)
    {type:"attach", id}                     attach (mirror/reconnect) -> replay
    {type:"stdin",  id, data(b64)}          write bytes to the PTY
    {type:"resize", id, cols, rows}         resize the PTY (main view only)
    {type:"close",  id}                     terminate the PTY
  server -> client:
    {type:"started", id, cid, cols, rows}
    {type:"replay",  id, data(b64), cols, rows}
    {type:"stdout",  id, data(b64)}
    {type:"exit",    id, code}
    {type:"error",   message}
"""
import asyncio
import base64
import json
import os
import re
import secrets
from typing import Any
from contextlib import asynccontextmanager

from dotenv import load_dotenv

# Load .env before anything reads the environment (e.g. ANTHROPIC_API_KEY for
# Agent nodes). Values already set in the real environment take precedence.
load_dotenv()

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from terminal import (
    SessionManager, Subscriber, build_node_tree, PipelineEngine, PipelineRun,
    WorkspaceStore, WorkspaceOrder,
)
from terminal.workspace_kinds import get_kind, kinds_manifest, WorkspaceError
from github.pulls import fetch_my_pulls, GitHubAuthError
from repos import RepoIndex
from slack import SlackService
from automations import AutomationStore, automation_kinds_manifest
from cicd import TeamCityService
from docs import DocsService

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "frontend", "dist")
WORKSPACES_FILE = os.path.join(HERE, "workspaces.json")
WORKSPACE_ORDER_FILE = os.path.join(HERE, "workspace_order.json")
REPOS_FILE = os.path.join(HERE, "repos.json")
SLACK_FILE = os.path.join(HERE, "slack.json")
AUTOMATIONS_FILE = os.path.join(HERE, "automations.json")
TEAMCITY_FILE = os.path.join(HERE, "teamcity.json")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(data: str) -> bytes:
    return base64.b64decode(data.encode("ascii"))


def to_wire(event: Any) -> Any:
    """Recursively encode bytes/bytearrays to base64 for the wire."""
    if isinstance(event, (bytes, bytearray)):
        return b64(event)
    if isinstance(event, dict):
        return {k: to_wire(v) for k, v in event.items()}
    if isinstance(event, list):
        return [to_wire(v) for v in event]
    return event


def to_wire_json(event: dict) -> str:
    """Serialise a domain/transport event to the JSON wire format."""
    return json.dumps(to_wire(event))


# Terminal capability QUERIES a program emits at startup (Device Attributes,
# cursor/status reports, XTVERSION, Kitty keyboard, DECRQM, OSC colour). They
# draw nothing, but a freshly-attached xterm replaying them will re-answer, and
# those answers get injected into the live program's stdin and echo back as
# visible garbage (e.g. ^[[?1;2c). Strip them from any replay.
_QUERY_RE = re.compile(
    rb"\x1b\[[0-9;]*c"               # Primary DA request
    rb"|\x1b\[[>=][0-9;]*c"          # Secondary/Tertiary DA request
    rb"|\x1b\[\??[0-9;]*n"           # DSR (cursor/status) request
    rb"|\x1b\[>[0-9;]*q"             # XTVERSION request
    rb"|\x1b\[\?[0-9;]*u"            # Kitty keyboard query
    rb"|\x1b\[\?[0-9;]*\$p"          # DECRQM request
    rb"|\x1b\][0-9]+;\?(?:\x07|\x1b\\)"  # OSC colour query
)


def _replay_data(sess) -> bytes:
    """Replay snapshot with terminal queries stripped (see _QUERY_RE)."""
    return _QUERY_RE.sub(b"", sess.snapshot())


class Hub:
    """Registry of connected transports, for broadcasting SHARED state to every
    open window so a new window mirrors the others: terminal/workspace lists and
    pipeline lifecycle events. (Per-session PTY output already fans out via
    Session.subscribers; this is for the cross-session events.)"""
    def __init__(self):
        self._subs = set()

    def add(self, sub):
        self._subs.add(sub)

    def remove(self, sub):
        self._subs.discard(sub)

    def empty(self) -> bool:
        return not self._subs

    def send(self, event: dict) -> None:
        for s in list(self._subs):
            s.send(event)


manager = SessionManager()
workspaces = WorkspaceStore(WORKSPACES_FILE)
workspace_order = WorkspaceOrder(WORKSPACE_ORDER_FILE)  # decoupled display order (tab reordering)
repo_index = RepoIndex(REPOS_FILE)  # local owner/name -> path map (scanned at startup)
slack_service = SlackService(SLACK_FILE)  # Slack client (token from slack.json / SLACK_TOKEN)
automation_store = AutomationStore(AUTOMATIONS_FILE)  # PR→workspace rules (frontend-evaluated)
teamcity_service = TeamCityService(TEAMCITY_FILE)  # CI/CD domain → TeamCity subdomain (IAP-fronted)
hub = Hub()
docs_service = DocsService(hub.send)  # Docs File Explorer: per-dir FS watchers, ref-counted by the UI

# Shared interactive-terminal registry (the Terminal-view tabs), mirrored to all
# windows. Each entry's id is a live PTY session owned by `manager`.
terminals = []   # [{"id": session_id, "title": str}]
_term_counter = 0


def _terminal_list_event() -> dict:
    return {"type": "terminal_list", "terminals": [dict(t) for t in terminals]}


def _create_terminal(shell: str, cols: int, rows: int):
    global _term_counter
    sess = manager.create(shell, cols, rows)
    _term_counter += 1
    terminals.append({"id": sess.id, "title": f"bash #{_term_counter}"})
    return sess


def _repos_event() -> dict:
    """The local-repo index for the client: configured roots + owner/name->path
    map. Broadcast so every window can resolve a PR to its local checkout and
    show/edit the roots near the connection indicator."""
    return {"type": "repos", **repo_index.to_json()}


def _slack_event() -> dict:
    """Slack connection state for the client: {configured, channels}. Never carries
    the token. Broadcast so every window's Slack tab reflects the current state."""
    return {"type": "slack", **slack_service.to_json()}


def _automations_event() -> dict:
    """User automation rules + the kind manifest that drives their editor.
    Broadcast so every window's Automations panel stays in sync (no secrets)."""
    return {"type": "automations", "kinds": automation_kinds_manifest(),
            **automation_store.to_json()}


def _cicd_event() -> dict:
    """CI/CD domain state for the client. Today: the TeamCity subdomain
    (connection state + the recent-build feed). Never carries a token/secret."""
    return {"type": "cicd", "teamcity": teamcity_service.to_json()}


def _workspace_list_event(created: str = None) -> dict:
    return {
        "type": "workspace_list",
        # The transient `closing` flag rides alongside the persisted definition.
        "workspaces": [{**w.to_json(), "closing": getattr(w, "closing", False)}
                       for w in workspaces.list()],
        "created": created,
        # Kind manifest so the create modal can render kind-agnostically.
        "kinds": kinds_manifest(),
        # Decoupled display order (a separate store; Workspace has no order field).
        # Self-healing against the live list: new workspaces append, deleted drop,
        # and the change is persisted — so no per-create/delete hooks are needed.
        "order": workspace_order.reconcile([w.id for w in workspaces.list()]),
    }


PR_POLL_INTERVAL = 20  # seconds — same cadence as the CI/CD (TeamCity) feed below


async def _poll_pulls():
    """Refresh the github.pulls inbox on an interval and broadcast to every window
    (hub), so an open PR view updates without a manual refresh. Paused when no
    windows are connected — don't call GitHub for nobody. The client's on-connect
    fetch covers the initial load, so this only sleeps-then-polls."""
    while True:
        await asyncio.sleep(PR_POLL_INTERVAL)
        if hub.empty():
            continue
        try:
            res = await fetch_my_pulls()
            hub.send({"type": "prs", **res})
        except GitHubAuthError as e:
            hub.send({"type": "prs", "prs": [], "error": str(e)})
        except Exception as e:  # never let a transient error kill the loop
            print(f"[pulls] poll error: {e}", flush=True)


SLACK_POLL_INTERVAL = 12  # seconds — refresh each watched Slack channel


async def _poll_slack():
    """Poll each watched Slack channel on an interval and broadcast its latest
    messages to every window, so a selected channel updates in near-real-time.
    Paused when no windows are connected, no token, or nothing is watched."""
    while True:
        await asyncio.sleep(SLACK_POLL_INTERVAL)
        if hub.empty() or not slack_service.configured():
            continue
        for ch in slack_service.poll_set():   # pinned + every multiplexer's channels
            try:
                msgs = await asyncio.to_thread(slack_service.channel_messages, ch, 30)
                hub.send({"type": "slack_messages", "channel": ch, "messages": msgs})
            except Exception as e:   # never let one channel kill the loop
                print(f"[slack] poll {ch}: {e}", flush=True)


CICD_POLL_INTERVAL = 20  # seconds — refresh the TeamCity build feed


async def _poll_cicd():
    """Refresh the TeamCity build feed on an interval and broadcast it, so the
    CI/CD view updates live. Paused when no windows are connected or not set up."""
    while True:
        await asyncio.sleep(CICD_POLL_INTERVAL)
        if hub.empty() or not teamcity_service.configured():
            continue
        try:
            await asyncio.to_thread(teamcity_service.refresh)
            hub.send(_cicd_event())
        except Exception as e:   # never let a blip kill the loop
            print(f"[teamcity] poll: {e}", flush=True)
        # Same loop/interval also refreshes each WATCHED branch (the union of open
        # branch panels) and broadcasts it, so every window updates live.
        for w in teamcity_service.watched_branches():
            try:
                builds = await asyncio.to_thread(
                    teamcity_service.branch_builds, w["branch"], w.get("repo", ""), 25)
                hub.send({"type": "teamcity_branch_builds", "branch": w["branch"],
                          "repo": w.get("repo", ""), "builds": builds})
            except Exception as e:
                print(f"[teamcity] poll branch {w.get('branch')}: {e}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager.loop = asyncio.get_running_loop()
    docs_service.set_loop(manager.loop)   # FS-watcher events marshal onto this loop
    # Kill any stale tmux server so sessions started by this run pick up the
    # current tmux.conf (tmux only reads its config when the server starts).
    manager.reset_backend()
    pulls_task = asyncio.create_task(_poll_pulls())
    slack_task = asyncio.create_task(_poll_slack())
    cicd_task = asyncio.create_task(_poll_cicd())
    yield
    pulls_task.cancel()
    slack_task.cancel()
    cicd_task.cancel()
    docs_service.stop_all()   # tear down all FS watchers + the observer thread
    manager.shutdown_all()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def index():
    # Never cache index.html: it references content-hashed asset bundles, so a
    # stale cached copy pins the browser to old JS/CSS even after a rebuild.
    # (The hashed /assets/* are safe to cache forever.)
    return FileResponse(
        os.path.join(DIST, "index.html"),
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


# Client-side deep-link routes — serve the SPA shell; the frontend reads the URL:
#   /shared/workspace/{id}/t/{nodeId}  -> Share view
#   /pipeline/new-workspace?…          -> pre-filled create-workspace modal
@app.get("/shared/{rest:path}")
@app.get("/pipeline/{rest:path}")
async def spa_route(rest: str):
    return FileResponse(
        os.path.join(DIST, "index.html"),
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


# ── Slack OAuth "Add to Slack" flow ──────────────────────────────────────────
# Open /slack/oauth/start (in a popup) -> Slack consent -> Slack redirects to
# /slack/oauth/callback?code=… -> we exchange it for a user token and the app's
# Slack tab flips to connected via the WS broadcast. State is a CSRF nonce; the
# redirect URI is the one configured in the Slack tab (must match the app's
# registered Redirect URL exactly). Single-user local tool, so one in-flight state.
_slack_oauth_state = None


@app.get("/slack/oauth/start")
async def slack_oauth_start():
    global _slack_oauth_state
    if not slack_service.has_app():
        return HTMLResponse("<h3>Slack OAuth isn't configured</h3>"
                            "<p>Enter your Client ID, Client Secret and redirect URL in the Slack tab first.</p>",
                            status_code=400)
    _slack_oauth_state = secrets.token_urlsafe(16)
    return RedirectResponse(slack_service.authorize_url(_slack_oauth_state))


@app.get("/slack/oauth/callback")
async def slack_oauth_callback(code: str = "", state: str = "", error: str = ""):
    if error:
        return HTMLResponse(f"<h3>Slack authorization was declined</h3><p>{error}</p>")
    if not code or not _slack_oauth_state or state != _slack_oauth_state:
        return HTMLResponse("<h3>Invalid OAuth response</h3>"
                            "<p>State mismatch or missing code — start again from the Slack tab.</p>",
                            status_code=400)
    res = await asyncio.to_thread(slack_service.oauth_exchange, code)
    if res.get("ok"):
        hub.send(_slack_event())   # the app's Slack tab flips to connected
        return HTMLResponse("<h3>✅ Slack connected</h3>"
                            "<p>You can close this tab and return to the app.</p>")
    return HTMLResponse(f"<h3>Slack connection failed</h3><p>{res.get('error')}</p>", status_code=400)


# Serve the Vite-built assets (JS chunks, CSS, etc.) from /assets/
if os.path.isdir(DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST, "assets")), name="assets")


def _resolve_cwd(raw: str, global_cwd: str) -> str:
    """Expand ~ and resolve relative paths, mirroring coordinator._resolve_cwd."""
    expanded = os.path.expanduser(raw)
    if not os.path.isabs(expanded):
        base = global_cwd if global_cwd else os.getcwd()
        expanded = os.path.join(base, expanded)
    return os.path.normpath(expanded)


def _validate_cwds(spec: dict, global_cwd: str = None) -> str:
    """Walk the spec tree and verify every resolved cwd exists.
    Returns an error string on the first bad path, or None if all are valid."""
    # Resolve global dir from root spec
    if spec.get("type") == "sequence" and spec.get("id") == "root" and spec.get("cwd"):
        global_cwd = _resolve_cwd(spec["cwd"], None)
        if not os.path.isdir(global_cwd):
            return f"Global dir does not exist or is not a directory: {global_cwd!r}"

    ntype = spec.get("type")
    if ntype in ("terminal", "fanout", "dynamic_batch", "agent"):
        # fanout/dynamic_batch children are created at runtime, but the node's
        # own cwd (its template's working dir) can still be validated up front.
        raw = spec.get("cwd")
        if raw:
            resolved = _resolve_cwd(raw, global_cwd)
            if not os.path.isdir(resolved):
                label = " ".join(spec.get("argv", [])) or spec.get("prompt", "")
                return f"Working directory does not exist for {label!r}: {resolved!r}"
    elif ntype in ("batch", "sequence"):
        for child in spec.get("nodes", []):
            err = _validate_cwds(child, global_cwd)
            if err:
                return err
    return None


def _workspace_run(sub: Subscriber, wid: str):
    """The live run for a workspace — resolved GLOBALLY via the workspace store
    (ws.run), so any connection (e.g. a shared deep-link) can reach a running
    workspace's inboxes/sessions, not just the one that started it. Falls back to
    this connection's legacy single run when no workspace_id is given."""
    if wid:
        ws = workspaces.get(wid)
        return ws.run if ws else None
    return getattr(sub, "run", None)


def _start_pipeline(sub, transport, spec, backend, initial_input, workspace_id, previous):
    """Validate, build, and kick off a pipeline run as a task. ``transport`` is
    the run's event bus (the Hub, so events broadcast to every window); ``sub`` is
    only for error replies. Returns the PipelineRun, or None on failure."""
    cwd_error = _validate_cwds(spec)
    if cwd_error:
        sub.send({"type": "error", "message": cwd_error})
        return None
    run = PipelineRun(transport, node_backend=backend, workspace_id=workspace_id, spec=spec)
    try:
        root = build_node_tree(spec, manager, run, outputs=run.node_outputs)
    except Exception as e:
        sub.send({"type": "error", "message": f"failed to build pipeline: {e}"})
        return None

    async def _run():
        # Cancel a still-running prior run of THIS run/workspace first so a re-run
        # doesn't leave orphaned PTYs (e.g. an interactive claude). Await teardown
        # so the old run's "pipeline_error" flushes before the new "pipeline_started".
        if previous and previous.task and not previous.task.done():
            previous.task.cancel()
            try:
                await previous.task
            except (asyncio.CancelledError, Exception):
                pass
        await PipelineEngine(root, run, outputs=run.node_outputs).execute(initial_input)

    run.task = asyncio.create_task(_run())
    return run


def handle_msg(sub: Subscriber, msg: dict) -> None:
    """Dispatch one client message; replies are enqueued on ``sub``."""
    mtype = msg.get("type")
    if mtype == "start":
        sess = manager.create(
            msg.get("shell", "bash"), int(msg["cols"]), int(msg["rows"])
        )
        manager.attach(sess, sub)
        sub.send(
            {
                "type": "started",
                "id": sess.id,
                "cid": msg.get("cid"),
                "cols": sess.cols,
                "rows": sess.rows,
            }
        )
        return

    if mtype == "run_pipeline":
        # Legacy single-pipeline path (no workspace). Kept working while the
        # frontend migrates to run_workspace.
        spec = msg.get("pipeline")
        if not spec:
            sub.send({"type": "error", "message": "missing pipeline spec"})
            return
        run = _start_pipeline(sub, sub, spec, msg.get("backend"), msg.get("input"),
                              workspace_id=None, previous=getattr(sub, "run", None))
        if run is not None:
            sub.run = run
        return

    if mtype == "run_workspace":
        # Concurrent path: each workspace has its own run, owned by the workspace
        # (ws.run) and broadcast to ALL windows via the Hub — so any window
        # mirrors it live. Re-running a workspace overrides its context (cancels
        # its prior run).
        wid = msg.get("workspace_id")
        ws = workspaces.get(wid)
        if not ws:
            sub.send({"type": "error", "message": "no such workspace"})
            return
        spec = msg.get("pipeline")
        if not spec:
            sub.send({"type": "error", "message": "missing pipeline spec"})
            return
        # The workspace's effective dir (a plain folder, or its git worktree) is
        # the run's base cwd — injected as the root sequence's cwd unless the DSL
        # set its own `dir:` (which then wins). This is what makes a worktree
        # workspace actually run its pipeline inside the worktree.
        if isinstance(spec, dict) and spec.get("type") == "sequence" \
                and not spec.get("cwd") and ws.dir:
            spec = {**spec, "cwd": ws.dir}
        run = _start_pipeline(sub, hub, spec, msg.get("backend"), msg.get("input"),
                              workspace_id=wid, previous=ws.run)
        if run is not None:
            ws.run = run  # workspace owns its latest run/context
        return

    if mtype in ("cancel_pipeline", "cancel_workspace"):
        run = _workspace_run(sub, msg.get("workspace_id"))
        if run and run.task and not run.task.done():
            run.task.cancel()
        return

    if mtype == "node_input":
        # User steering for a running coordinator agent — route to its inbox.
        # Resolved via the workspace's run, so a shared deep-link (a different
        # connection) can drive a HITL node and unblock the real pipeline.
        run = _workspace_run(sub, msg.get("workspace_id"))
        inbox = run.agent_inboxes.get(msg.get("node_id")) if run else None
        if inbox is not None:
            inbox.put_nowait(msg.get("text", ""))
        return

    if mtype == "attach_node":
        # Shared deep-link: resolve (workspace, node) -> its live session and
        # attach this connection to it (replay + live output), so a focused
        # single-node view can mirror and drive it.
        wid = msg.get("workspace_id")
        nid = msg.get("node_id")
        run = _workspace_run(sub, wid)
        sid = run.node_sessions.get(nid) if run else None
        sess = manager.sessions.get(sid) if sid else None
        if not sess:
            sub.send({"type": "node_attached", "workspace_id": wid, "node_id": nid,
                      "error": "node is not running"})
            return
        manager.attach(sess, sub)
        sub.send({
            "type": "node_attached", "workspace_id": wid, "node_id": nid,
            "id": sess.id, "data": _replay_data(sess), "cols": sess.cols, "rows": sess.rows,
            # A virtual (no-pid) session is a coordinator -> line-based node_input;
            # a real PTY node takes raw stdin.
            "agent": sess.pid is None,
        })
        return

    # ── State sync (new window) ──────────────────────────────────────────────
    if mtype == "sync":
        # A freshly-opened window: hand it the shared lists, then replay each
        # running run's event log so it reconstructs the live trees. Live events
        # follow via the Hub. (Node terminal output then comes from each session's
        # own subscribers as the window attaches per node card.)
        sub.send(_terminal_list_event())
        sub.send(_workspace_list_event())
        sub.send(_repos_event())
        sub.send(_slack_event())
        sub.send(_automations_event())
        sub.send(_cicd_event())
        for ws in workspaces.list():
            run = ws.run
            if run and run.task and not run.task.done():
                for ev in list(run.event_log):
                    sub.send(ev)
        return

    # ── Shared interactive terminals (mirrored to every window) ──────────────
    if mtype == "list_terminals":
        sub.send(_terminal_list_event())
        return

    if mtype == "create_terminal":
        _create_terminal(msg.get("shell", "bash"), int(msg.get("cols", 80)), int(msg.get("rows", 24)))
        hub.send(_terminal_list_event())
        return

    if mtype == "close_terminal":
        tid = msg.get("id")
        s = manager.sessions.get(tid)
        if s:
            manager.kill(s)
        terminals[:] = [t for t in terminals if t["id"] != tid]
        hub.send(_terminal_list_event())
        return

    if mtype == "restart_terminal":
        entry = next((t for t in terminals if t["id"] == msg.get("id")), None)
        if entry:
            old = manager.sessions.get(entry["id"])
            if old:
                manager.kill(old)
            s = manager.create("bash", int(msg.get("cols", 80)), int(msg.get("rows", 24)))
            entry["id"] = s.id  # keep the title; swap to the fresh session
            hub.send(_terminal_list_event())
        return

    # ── Workspace CRUD (broadcast so every window's session list stays in sync) ─
    if mtype == "list_workspaces":
        sub.send(_workspace_list_event())
        return

    if mtype == "create_workspace":
        kind_id = msg.get("kind", "directory")
        # Back-compat: an older client sends {dir, name} with no kind/fields.
        fields = msg.get("fields") or {"dir": msg.get("dir")}
        # Get-or-create: for an EXCLUSIVE kind (worktree: one per repo+branch),
        # re-creating the same one just loads it instead of erroring — so "Work on
        # this" on a PR whose worktree already exists navigates to it.
        existing = workspaces.find_existing(kind_id, fields)
        if existing is not None:
            hub.send(_workspace_list_event(created=existing.id))
            return
        try:
            ws = workspaces.create(kind_id, fields, name=msg.get("name"))
        except WorkspaceError as e:
            sub.send({"type": "error", "message": str(e)})
            return
        # Transparency: if the worktree's branch came from origin (e.g. a PR/
        # dependabot branch we had to fetch), say so.
        if ws.meta.get("source") == "remote":
            sub.send({"type": "notice", "message": f"Fetched origin/{ws.meta.get('branch')} and created the worktree."})
        hub.send(_workspace_list_event(created=ws.id))
        return

    if mtype == "ensure_workspace":
        # Get-or-create + optional auto-run. The frontend automation engine calls
        # this for a new PR: idempotent for an exclusive kind (worktree — one per
        # repo+branch), so re-detecting the same PR never duplicates. `pipeline`
        # (a parsed spec) runs once on FIRST creation; `dsl` seeds the side panel;
        # `focus` selects the workspace (manual use) — omitted for background
        # creates, whose tab appears without stealing the active view.
        kind_id = msg.get("kind", "worktree")
        fields = msg.get("fields") or {}
        focus = bool(msg.get("focus"))
        existing = workspaces.find_existing(kind_id, fields)
        if existing is not None:
            if focus:
                hub.send(_workspace_list_event(created=existing.id))
            sub.send({"type": "workspace_ensured", "workspace_id": existing.id, "existed": True})
            return
        try:
            ws = workspaces.create(kind_id, fields, name=msg.get("name"),
                                   extra_meta=msg.get("meta"))
        except WorkspaceError as e:
            sub.send({"type": "error", "message": str(e)})
            return
        spec = msg.get("pipeline")
        if spec:
            if msg.get("dsl"):
                workspaces.set_pipeline(ws.id, msg["dsl"])  # show the rule's DSL in the panel
            # Inject the worktree dir as the run's base cwd (as run_workspace does).
            if isinstance(spec, dict) and spec.get("type") == "sequence" \
                    and not spec.get("cwd") and ws.dir:
                spec = {**spec, "cwd": ws.dir}
            run = _start_pipeline(sub, hub, spec, msg.get("backend"),
                                  msg.get("input"), workspace_id=ws.id, previous=None)
            if run is not None:
                ws.run = run
        # Background create: no `created` => the tab appears but the active view
        # is left alone. Manual (focus) creates select it.
        hub.send(_workspace_list_event(created=ws.id if focus else None))
        sub.send({"type": "workspace_ensured", "workspace_id": ws.id, "existed": False})
        return

    if mtype == "list_automations":
        sub.send(_automations_event())
        return

    if mtype == "save_automation":
        automation_store.save_rule(msg.get("rule") or {})
        hub.send(_automations_event())
        return

    if mtype == "delete_automation":
        automation_store.delete_rule(msg.get("id"))
        hub.send(_automations_event())
        return

    # ── CI/CD domain → TeamCity subdomain (IAP-fronted; calls run via to_thread) ─
    if mtype == "set_teamcity_config":
        teamcity_service.set_config(url=msg.get("url"), token=msg.get("token"),
                                    client_id=msg.get("clientId"),
                                    client_secret=msg.get("clientSecret"))
        hub.send(_cicd_event())   # configured/url flags — never the token/secret
        return

    if mtype == "connect_teamcity":
        async def _connect():
            res = await asyncio.to_thread(teamcity_service.connect)  # opens browser
            if not res.get("ok"):
                sub.send({"type": "error", "message": f"TeamCity connect: {res.get('error')}"})
            hub.send(_cicd_event())
        asyncio.create_task(_connect())
        return

    if mtype == "teamcity_refresh":
        async def _refresh_teamcity():
            await asyncio.to_thread(teamcity_service.refresh)
            hub.send(_cicd_event())
        asyncio.create_task(_refresh_teamcity())
        return

    if mtype == "teamcity_set_watched_branches":
        # The UI's ref-counted union of open branch panels. Store it, then fetch +
        # broadcast each immediately so a freshly-mounted panel doesn't wait a poll
        # cycle; the poller keeps them live thereafter.
        async def _set_watched():
            watched = await asyncio.to_thread(
                teamcity_service.set_watched_branches, msg.get("branches") or [])
            for w in watched:
                builds = await asyncio.to_thread(
                    teamcity_service.branch_builds, w["branch"], w.get("repo", ""), 25)
                hub.send({"type": "teamcity_branch_builds", "branch": w["branch"],
                          "repo": w.get("repo", ""), "builds": builds})
        asyncio.create_task(_set_watched())
        return

    if mtype == "docs_set_watched":
        # The UI's ref-counted union of open docs-explorer directories. Mirror it: start
        # an FS watcher per new dir (off-loop — set_watched does filesystem I/O) and
        # broadcast each new dir's tree; watchers fire further updates on OS events.
        asyncio.create_task(asyncio.to_thread(docs_service.set_watched, msg.get("dirs") or []))
        return

    if mtype == "teamcity_project_builds":
        # On-demand: a project's recent builds (the global feed is Monolith-heavy,
        # so quieter projects need their own fetch). Reply to the asking window.
        async def _project_builds():
            pid = msg.get("projectId")
            builds = await asyncio.to_thread(teamcity_service.project_builds, pid, 50)
            sub.send({"type": "teamcity_project_builds", "projectId": pid, "builds": builds})
        asyncio.create_task(_project_builds())
        return

    if mtype in ("teamcity_trigger", "teamcity_cancel", "teamcity_rerun"):
        async def _tc_write():
            if mtype == "teamcity_trigger":
                res = await asyncio.to_thread(teamcity_service.trigger,
                                              msg.get("buildTypeId"), msg.get("branch"))
            elif mtype == "teamcity_cancel":
                res = await asyncio.to_thread(teamcity_service.cancel,
                                              msg.get("buildId"), msg.get("state") or "")
            else:
                res = await asyncio.to_thread(teamcity_service.rerun, msg.get("buildId"))
            if not res.get("ok"):
                sub.send({"type": "error", "message": f"TeamCity: {res.get('error')}"})
            await asyncio.to_thread(teamcity_service.refresh)   # reflect the change
            hub.send(_cicd_event())
        asyncio.create_task(_tc_write())
        return

    if mtype == "set_pipeline":
        workspaces.set_pipeline(msg.get("workspace_id"), msg.get("dsl", ""))
        hub.send(_workspace_list_event())
        return

    if mtype == "set_workspace_theme":
        workspaces.set_theme(msg.get("workspace_id"), msg.get("theme", "tropical"))
        hub.send(_workspace_list_event())
        return

    if mtype == "set_workspace_order":
        # Decoupled tab ordering (drag-to-reorder). Persisted + broadcast so every
        # window's tab order matches and survives reload/reconnect.
        workspace_order.set(msg.get("order") or [])
        hub.send(_workspace_list_event())
        return

    if mtype == "delete_workspace":
        wid = msg.get("workspace_id")
        ws = workspaces.get(wid)
        if ws is None or ws.closing:   # ignore a re-close while one is already in flight
            return
        remove = bool(msg.get("remove_resources"))
        force = bool(msg.get("force"))

        async def _close():
            # Mark closing + broadcast so every window shows the tab tearing down.
            ws.closing = True
            hub.send(_workspace_list_event())
            # Stop any in-flight run and WAIT for its teardown (child PTYs killed,
            # processes exited) BEFORE touching the worktree — otherwise cleanup
            # would run under a live process and race the kill.
            if ws.run is not None and ws.run.task is not None and not ws.run.task.done():
                ws.run.task.cancel()
                try:
                    await ws.run.task
                except (asyncio.CancelledError, Exception):
                    pass
            # The client decides per-close whether to tear down a worktree ("ask
            # each time"). cleanup is safe by default (git refuses on uncommitted
            # changes); if it refuses and the user didn't force, KEEP the workspace
            # so they can retry with Force or choose Keep — and say why. The git
            # work runs off the event loop so it never blocks other windows.
            if remove:
                warnings = await asyncio.get_running_loop().run_in_executor(
                    None, lambda: get_kind(ws.kind).cleanup(ws.meta, force=force))
                if warnings and not force:
                    ws.closing = False   # un-close: back to a normal workspace
                    hub.send(_workspace_list_event())
                    sub.send({"type": "workspace_cleanup_blocked", "workspace_id": wid, "message": warnings[0]})
                    return
            # Session stopped + resources cleaned -> drop the record; tab vanishes.
            workspaces.delete(wid)
            hub.send(_workspace_list_event())

        asyncio.create_task(_close())
        return

    if mtype == "set_repo_roots":
        # Update the configured scan roots (persisted) and re-index. Scan shells
        # git per repo, so run it off the event loop, then broadcast the new map.
        async def _set_roots():
            await asyncio.get_running_loop().run_in_executor(
                None, repo_index.set_roots, msg.get("roots") or [])
            hub.send(_repos_event())
        asyncio.create_task(_set_roots())
        return

    if mtype == "refresh_repos":
        async def _refresh():
            await asyncio.get_running_loop().run_in_executor(None, repo_index.scan)
            hub.send(_repos_event())
        asyncio.create_task(_refresh())
        return

    if mtype == "list_prs":
        # github.pulls subdomain — fetch the viewer's open PRs (raised / assigned /
        # review-requested) via gh. Async (gh call), so reply on a task. The client
        # asks on connect/reconnect (so data is fresh per connection) + manual refresh.
        async def _list_prs():
            try:
                res = await fetch_my_pulls()
                sub.send({"type": "prs", **res})
            except GitHubAuthError as e:
                sub.send({"type": "prs", "prs": [], "error": str(e)})
        asyncio.create_task(_list_prs())
        return

    # ── slack domain (read channels/messages/mentions, post a message) ────────
    # WebClient is blocking, so every call runs via asyncio.to_thread.
    if mtype == "set_slack_token":
        async def _set_token():
            await asyncio.to_thread(
                slack_service.set_token, msg.get("token") or "", msg.get("cookie") or "")
            hub.send(_slack_event())   # configured + channels — never the token/cookie
        asyncio.create_task(_set_token())
        return

    if mtype == "set_slack_app":
        # Store OAuth app creds (Client ID/Secret + redirect URI) for the
        # "Add to Slack" flow. The secret stays server-side (gitignored slack.json).
        async def _set_app():
            await asyncio.to_thread(
                slack_service.set_app, msg.get("client_id") or "",
                msg.get("client_secret") or "", msg.get("redirect_uri") or "")
            hub.send(_slack_event())
        asyncio.create_task(_set_app())
        return

    if mtype == "set_slack_polled":
        # Channels the background poller watches for new messages. Persisted +
        # broadcast (so every window's selection stays in sync).
        async def _set_polled():
            await asyncio.to_thread(slack_service.set_polled, msg.get("channels") or [])
            hub.send(_slack_event())
        asyncio.create_task(_set_polled())
        return

    if mtype == "set_slack_multiplexers":
        # Read-only merge views [{id, name, channels}]. The frontend does the
        # merging; the server just persists the definitions and folds their
        # channels into the poll set so they stay subscribed.
        async def _set_mux():
            await asyncio.to_thread(slack_service.set_multiplexers, msg.get("multiplexers") or [])
            hub.send(_slack_event())
        asyncio.create_task(_set_mux())
        return

    if mtype == "refresh_slack":
        async def _refresh_slack():
            await asyncio.to_thread(slack_service.refresh)
            hub.send(_slack_event())
        asyncio.create_task(_refresh_slack())
        return

    if mtype == "slack_channel_messages":
        async def _slack_history():
            msgs = await asyncio.to_thread(
                slack_service.channel_messages, msg.get("channel"), int(msg.get("limit", 30)))
            sub.send({"type": "slack_messages", "channel": msg.get("channel"), "messages": msgs})
        asyncio.create_task(_slack_history())
        return

    if mtype == "slack_mentions":
        async def _slack_mentions():
            items = await asyncio.to_thread(slack_service.my_mentions)
            sub.send({"type": "slack_mentions", "mentions": items})
        asyncio.create_task(_slack_mentions())
        return

    if mtype == "slack_send":
        async def _slack_send():
            res = await asyncio.to_thread(
                slack_service.post_message, msg.get("channel"), msg.get("text") or "")
            sub.send({"type": "slack_sent", "channel": msg.get("channel"), **res})
        asyncio.create_task(_slack_send())
        return

    sess = manager.sessions.get(msg.get("id"))
    if mtype == "attach":
        if not sess:
            # The session already ended (e.g. a cancelled/closed run that the
            # client re-attaches to a beat later). Nothing to subscribe to —
            # silently ignore rather than surfacing a spurious error toast.
            return
        manager.attach(sess, sub)
        sub.send(
            {
                "type": "replay",
                "id": sess.id,
                "data": _replay_data(sess),
                "cols": sess.cols,
                "rows": sess.rows,
            }
        )
    elif mtype == "stdin":
        if sess:
            manager.write(sess, unb64(msg["data"]))
    elif mtype == "resize":
        if sess:
            manager.resize(sess, int(msg["cols"]), int(msg["rows"]))
    elif mtype == "open_in_terminal":
        # Launch this session in the real macOS Terminal. Only PTY-backed
        # sessions (with a pid) can be opened; virtual agent sessions can't.
        if sess and sess.pid is not None:
            try:
                manager.open_in_terminal(sess)
            except Exception as e:
                sub.send({"type": "error", "message": f"open in terminal failed: {e}"})
        else:
            sub.send({"type": "error", "message": "cannot open this session in Terminal"})
    elif mtype == "close":
        if sess:
            manager.kill(sess)


async def _drain(ws: WebSocket, sub: Subscriber) -> None:
    """Pump events from the subscriber queue out over the WebSocket."""
    while True:
        event = await sub.get()
        try:
            await ws.send_text(to_wire_json(event))
        except Exception:
            break  # connection gone; ws_endpoint handles detach/cleanup


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    sub = Subscriber()
    hub.add(sub)  # receive broadcast state/run events
    drain = asyncio.create_task(_drain(ws, sub))
    try:
        while True:
            try:
                raw = await ws.receive_text()
                msg = json.loads(raw)
            except json.JSONDecodeError as e:
                sub.send({"type": "error", "message": f"bad json: {e}"})
                continue
            try:
                handle_msg(sub, msg)
            except Exception as e:
                # Log and tell the client, but keep the connection alive.
                print(f"[ws] handle_msg error: {e!r}")
                sub.send({"type": "error", "message": str(e)})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[ws] fatal error: {e!r}")
    finally:
        # The legacy single run is connection-scoped — cancel it. Workspace runs
        # are SHARED (workspace-owned, broadcast), so another window may still be
        # watching: only cancel them once NO windows remain, to avoid leaving a
        # coordinator looping (spending API credits) with no viewers.
        legacy = getattr(sub, "run", None)
        if legacy and legacy.task and not legacy.task.done():
            legacy.task.cancel()
        hub.remove(sub)
        manager.detach(sub)
        drain.cancel()
        if hub.empty():
            # No windows left: drop all docs FS watchers (the UI re-registers its open
            # panels on reconnect, same as the TeamCity watched set).
            docs_service.set_watched([])
            for ws in workspaces.list():
                run = ws.run
                if run and run.task and not run.task.done():
                    run.task.cancel()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
