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
import tempfile
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
from slack.sentiment import SentimentService
from automations import AutomationStore, automation_kinds_manifest
from agents.collab import CollabRun
from cicd import TeamCityService
from docs_explorer import DocsService

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "frontend", "dist")
WORKSPACES_FILE = os.path.join(HERE, "workspaces.json")
WORKSPACE_ORDER_FILE = os.path.join(HERE, "workspace_order.json")
REPOS_FILE = os.path.join(HERE, "repos.json")
SLACK_FILE = os.path.join(HERE, "slack.json")
SLACK_SENTIMENT_FILE = os.path.join(HERE, "slack_sentiment.json")
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

    def count(self) -> int:
        return len(self._subs)

    def subscribers(self):
        return list(self._subs)

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
# slack → sentiment subdomain: optional "is this message important?" Haiku triage,
# side-table keyed by channel:ts. Decoupled — the slack poll just forwards its batch.
sentiment_service = SentimentService(hub.send, SLACK_SENTIMENT_FILE)

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


def _presence_event() -> dict:
    """Live presence across all open windows: the total window count plus a roster
    of each connection — its stable id and the workspace/world it's focused on
    (None when not on a workspace's WorldView). Foundation for WorldView avatars:
    next we add each window's camera coords under the same id."""
    roster = []
    for s in hub.subscribers():
        pid = getattr(s, "presence_id", None)
        if pid:
            roster.append({"id": pid, "focus": getattr(s, "focus", None)})
    return {"type": "presence", "windows": hub.count(), "roster": roster}


def _cicd_event() -> dict:
    """CI/CD domain state for the client. Today: the TeamCity subdomain
    (connection state + the recent-build feed). Never carries a token/secret."""
    return {"type": "cicd", "teamcity": teamcity_service.to_json()}


def _workspace_list_event(created: str = None, created_by: str = None) -> dict:
    return {
        "type": "workspace_list",
        # The transient `closing` flag rides alongside the persisted definition.
        "workspaces": [{**w.to_json(), "closing": getattr(w, "closing", False)}
                       for w in workspaces.list()],
        "created": created,
        # Presence id of the window that created it — only THAT window auto-navigates
        # to the new tab; everyone else sees it appear but stays where they are.
        "created_by": created_by,
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
        batch = []   # accumulate the poll's messages for the optional sentiment pass
        for ch in slack_service.poll_set():   # pinned + every multiplexer's channels
            try:
                msgs = await asyncio.to_thread(slack_service.channel_messages, ch, 30)
                hub.send({"type": "slack_messages", "channel": ch, "messages": msgs})
                for m in msgs:
                    batch.append({"channel": ch, "ts": m.get("ts"),
                                  "user": m.get("user"), "text": m.get("text")})
            except Exception as e:   # never let one channel kill the loop
                print(f"[slack] poll {ch}: {e}", flush=True)
        # Importance triage: scores only NEW messages (no-op if disabled or nothing
        # new), so the 12s poll doubles as the coalesce window — a Haiku call only
        # fires when fresh messages arrived. Never let it break the loop.
        try:
            await sentiment_service.maybe_score(batch)
        except Exception as e:
            print(f"[sentiment] poll score: {e}", flush=True)


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
        # Same loop refreshes each watched build config's status (the trigger tiles'
        # LEDs) — keyed by config id + branch, so deploy/terraform configs on other
        # VCS roots still report correctly.
        for w in teamcity_service.watched_build_types():
            try:
                build = await asyncio.to_thread(
                    teamcity_service.build_type_status, w["buildTypeId"], w["branch"])
                hub.send({"type": "teamcity_buildtype_status", "buildTypeId": w["buildTypeId"],
                          "branch": w["branch"], "build": build})
            except Exception as e:
                print(f"[teamcity] poll buildtype {w.get('buildTypeId')}: {e}", flush=True)


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
    # Gracefully tear down any active workspace runs so their agent subprocesses
    # (SDK `claude` clients, ACP pools) are closed, not orphaned. The SDK also has
    # an atexit safety net for its own children, but ACP pools aren't covered by it.
    for ws in workspaces.list():
        run = getattr(ws, "run", None)
        if run is None:
            continue
        task = getattr(run, "task", None)
        if task is not None and not task.done():
            task.cancel()
        if hasattr(run, "close"):
            try:
                await run.close()
            except Exception:  # noqa: BLE001 — best-effort shutdown
                pass
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


def _watched_docs_union() -> list:
    """Union of every connected window's watched docs dirs (the read/write boundary)."""
    union = set()
    for s in hub.subscribers():
        union |= getattr(s, "watched_docs", set())
    return sorted(union)


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
        try:
            await PipelineEngine(root, run, outputs=run.node_outputs).execute(initial_input)
        finally:
            # Kill any ACP agent subprocesses this run spawned (also on cancel).
            await run.close_acp()

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

    if mtype == "run_collab":
        # Activate a Collab workspace: spin up its CollabRun (one agent process),
        # ready to accept sessions. Cancels any prior run (re-run overrides).
        wid = msg.get("workspace_id")
        ws = workspaces.get(wid)
        if not ws or getattr(ws, "surface", None) != "collab":
            sub.send({"type": "error", "message": "no such collab workspace"})
            return
        prev = ws.run
        if prev and getattr(prev, "task", None) and not prev.task.done():
            prev.task.cancel()
        run = CollabRun(hub, wid, msg.get("agent", "stub"), ws.dir)
        run.task = asyncio.create_task(run.serve())
        ws.run = run
        run.send({"type": "collab_started", "agent": run.agent})
        return

    if mtype == "collab_add_session":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.add_session(kickoff=msg.get("kickoff"), temp_id=msg.get("temp_id")))
        return

    if mtype == "collab_fork_session":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.fork_session(
                msg.get("from_session_id"), msg.get("seed_prompt"),
                sender=getattr(sub, "presence_id", None)))
        return

    if mtype == "collab_prompt":
        # Send-to-agent: a prompt turn on one session, tagged with the sender's
        # presence id (server-authoritative — not trusting the client's claim).
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.prompt(
                msg.get("session_id"), msg.get("text", ""),
                sender=getattr(sub, "presence_id", None)))
        return

    if mtype == "collab_chat":
        # Broadcast-only chat message (not sent to the agent).
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            run.chat(msg.get("session_id"), msg.get("text", ""), getattr(sub, "presence_id", None))
        return

    if mtype == "collab_annotation_add":
        # Save a review annotation (highlighted text + note) on a session, shared.
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            run.add_annotation(msg.get("session_id"), msg.get("seq"), msg.get("start"), msg.get("end"),
                               msg.get("text", ""), msg.get("note", ""), getattr(sub, "presence_id", None),
                               kind=msg.get("kind", "add"))
        return

    if mtype == "collab_annotation_remove":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            run.remove_annotation(msg.get("session_id"), msg.get("id"))
        return

    if mtype == "collab_annotation_update":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            run.update_annotation(msg.get("session_id"), msg.get("id"), msg.get("note", ""))
        return

    if mtype == "collab_annotation_clear":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            run.clear_annotations(msg.get("session_id"))
        return

    if mtype == "collab_prompt_item_add":
        # External prompt material (e.g. a doc selection → suggested edit), shared like
        # an annotation. Stamped with the sender's presence id.
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            run.add_prompt_item(msg.get("session_id"), msg.get("kind", "edit"),
                                msg.get("text", ""), msg.get("note", ""), getattr(sub, "presence_id", None))
        return

    if mtype == "collab_prompt_item_remove":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            run.remove_prompt_item(msg.get("session_id"), msg.get("id"))
        return

    if mtype == "collab_prompt_item_clear":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            run.clear_prompt_items(msg.get("session_id"))
        return

    if mtype == "collab_command":
        # [collab-command] route a natural-language command to the workspace's control agent
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.control_command(msg.get("text", ""), getattr(sub, "presence_id", None)))
        return

    if mtype == "collab_explore_selection":
        # Fork a sub-agent to explore a highlighted excerpt without holding up the
        # source agent (returns to it on demand).
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.explore_from_selection(
                msg.get("session_id"), msg.get("text", ""), msg.get("note", ""),
                sender=getattr(sub, "presence_id", None)))
        return

    if mtype == "open_editor_agent":
        # Launch the dedicated markdown-editor agent for a file; reply to the asker.
        run = _workspace_run(sub, msg.get("workspace_id"))
        file = msg.get("file", "")
        if isinstance(run, CollabRun):
            async def _open():
                sid = await run.open_editor_agent(file)
                sub.send({"type": "editor_agent_opened", "file": file, "session_id": sid})
            asyncio.create_task(_open())
        else:
            sub.send({"type": "editor_agent_opened", "file": file, "session_id": None,
                      "error": "Run a Collab session first"})
        return

    if mtype == "editor_agent_prompt":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.editor_agent_prompt(
                msg.get("session_id"), msg.get("text", ""), sender=getattr(sub, "presence_id", None)))
        return

    if mtype == "close_editor_agent":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.close_editor_agent(msg.get("session_id")))
        return

    if mtype == "prompt_typing":
        # Live draft of a user's agent-prompt input (NOT chat) — relayed to all so
        # others see what's being typed + where the caret is. Empty text clears.
        hub.send({
            "type": "prompt_draft", "workspace_id": msg.get("workspace_id"),
            "session_id": msg.get("session_id"), "text": msg.get("text", ""),
            "cursor": msg.get("cursor", 0), "user": getattr(sub, "presence_id", None),
        })
        return

    if mtype in ("doc_join", "doc_update", "doc_state", "doc_awareness"):
        # Collaborative Markdown editing: Yjs updates + awareness relayed over the shared
        # socket. The server is a DUMB relay — never merges CRDT state; it only keeps a
        # per-file replay log (on the CollabRun) so a late joiner can catch up. Merging
        # happens in each browser's Y.Doc. Kept off the run's event_log (file-scoped/high
        # volume) — we broadcast via hub.send like prompt_typing.
        run = _workspace_run(sub, msg.get("workspace_id"))
        if not isinstance(run, CollabRun):
            return
        file = msg.get("file")
        user = getattr(sub, "presence_id", None)
        if mtype == "doc_join":
            existed, updates = run.doc_join(file)
            sub.send({"type": "doc_sync", "workspace_id": msg.get("workspace_id"),
                      "file": file, "existed": existed, "updates": updates})
        elif mtype == "doc_update":
            run.doc_append(file, msg.get("update", ""))
            hub.send({"type": "doc_update", "workspace_id": msg.get("workspace_id"),
                      "file": file, "update": msg.get("update", ""), "user": user})
        elif mtype == "doc_state":
            run.doc_replace_state(file, msg.get("state", ""))  # compaction — cache only
        else:  # doc_awareness — ephemeral cursors/selections, not logged
            hub.send({"type": "doc_awareness", "workspace_id": msg.get("workspace_id"),
                      "file": file, "state": msg.get("state"), "user": user})
        return

    if mtype == "annotation_select":
        # A user's live/final text-selection annotation over an agent message —
        # relay to all windows, stamping the authoritative sender. Ephemeral (not
        # logged): an empty span (start == end) clears that user's annotation.
        hub.send({
            "type": "annotation_selection", "workspace_id": msg.get("workspace_id"),
            "session_id": msg.get("session_id"), "seq": msg.get("seq"),
            "start": msg.get("start"), "end": msg.get("end"),
            "live": bool(msg.get("live")), "user": getattr(sub, "presence_id", None),
        })
        return

    if mtype == "collab_cancel":
        # Interrupt one session's current agent turn.
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            run.cancel(msg.get("session_id"))
        return

    if mtype == "collab_remove_session":
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.remove_session(msg.get("session_id")))
        return

    if mtype == "collab_take_over":
        # A human grabs a running sub-agent -> human-gated (mirror: stop_task +
        # resume; delegate: interrupt + wait for return).
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.take_over(msg.get("session_id")))
        return

    if mtype == "collab_return":
        # Hand a human-gated sub-agent's result back to the coordinator.
        run = _workspace_run(sub, msg.get("workspace_id"))
        if isinstance(run, CollabRun):
            asyncio.create_task(run.return_to_coordinator(msg.get("session_id"), msg.get("summary")))
        return

    if mtype == "stop_collab":
        # Tear down the whole Collab runtime (kills agent + all sessions) but keep
        # the workspace, so it can be Run again.
        wid = msg.get("workspace_id")
        ws = workspaces.get(wid)
        run = ws.run if ws else None
        if isinstance(run, CollabRun):
            if run.task and not run.task.done():
                run.task.cancel()
            # Close in a FRESH task (idempotent) so the multi-second subprocess
            # teardown isn't interrupted by the cancelled keepalive task's unwind.
            asyncio.create_task(run.close())
            ws.run = None
            hub.send({"type": "collab_stopped", "workspace_id": wid})
        return

    if mtype in ("acp_set_mode", "acp_set_model"):
        # Change a running session's mode/model. The target id is a node_id
        # (pipeline) or a session_id (collab panel). Prefer the session object —
        # both AcpSession and SdkSession expose set_mode/set_model — so an SDK
        # panel works uniformly; fall back to the raw ACP client for pipeline
        # nodes registered only in acp_sessions.
        run = _workspace_run(sub, msg.get("workspace_id"))
        target = msg.get("node_id") or msg.get("session_id")
        sess = getattr(run, "sessions", {}).get(target) if run else None
        if sess is not None and hasattr(sess, "set_mode"):
            if mtype == "acp_set_mode":
                asyncio.create_task(sess.set_mode(msg.get("mode_id")))
            else:
                asyncio.create_task(sess.set_model(msg.get("model_id")))
            return
        entry = getattr(run, "acp_sessions", {}).get(target) if run else None
        if entry is not None:
            client, session_id = entry
            if mtype == "acp_set_mode":
                method, params = "session/set_mode", {"sessionId": session_id, "modeId": msg.get("mode_id")}
            else:
                method, params = "session/set_model", {"sessionId": session_id, "modelId": msg.get("model_id")}
            asyncio.create_task(client.request(method, params))  # fire-and-forget; agent echoes current_*_update
        return

    if mtype == "acp_finish":
        # User pressed Finish on a conversational ACP node — signal its loop to end
        # (sentinel None on the inbox), resolved via the workspace's run.
        run = _workspace_run(sub, msg.get("workspace_id"))
        inbox = run.agent_inboxes.get(msg.get("node_id")) if run else None
        if inbox is not None:
            inbox.put_nowait(None)
        return

    if mtype == "acp_permission_reply":
        # A window answered an ACP node's permission prompt — resolve the awaiting
        # future on the workspace's run (shared, so any window can approve).
        run = _workspace_run(sub, msg.get("workspace_id"))
        registry = getattr(run, "acp_perms", None) if run else None
        if registry is not None:
            fut = registry.get(msg.get("request_id"))  # token is globally unique
            if fut is not None and not fut.done():
                fut.set_result(msg.get("option_id"))
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
        sub.send(sentiment_service.full_event())   # slack sentiment side-table + config
        sub.send(_automations_event())
        sub.send(_cicd_event())
        for ws in workspaces.list():
            run = ws.run
            if run and run.task and not run.task.done():
                for ev in list(run.event_log):
                    sub.send(ev)
                if isinstance(run, CollabRun):
                    run.resend_meta(sub)  # ensure this window has the full merged controls
        return

    if mtype == "presence_focus":
        # This window reports which workspace/world it's currently in (None when
        # off the WorldView). Re-broadcast the roster so every window sees it.
        sub.focus = msg.get("workspace_id")
        hub.send(_presence_event())
        return

    if mtype == "presence_pos":
        # High-frequency WorldView camera pose. Relay ONLY to windows in the SAME
        # world (matching focus), tagged with the sender's id — so each window
        # renders the others as avatars. Never echoed back to the sender.
        foc = getattr(sub, "focus", None)
        if foc is None:
            return
        ev = {"type": "presence_pos", "id": sub.presence_id,
              "x": msg.get("x"), "y": msg.get("y"), "z": msg.get("z"), "yaw": msg.get("yaw")}
        for s in hub.subscribers():
            if s is not sub and getattr(s, "focus", None) == foc:
                s.send(ev)
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
            hub.send(_workspace_list_event(created=existing.id, created_by=sub.presence_id))
            return
        try:
            ws = workspaces.create(kind_id, fields, name=msg.get("name"),
                                   surface=msg.get("surface", "pipeline"))
        except WorkspaceError as e:
            sub.send({"type": "error", "message": str(e)})
            return
        # Transparency: if the worktree's branch came from origin (e.g. a PR/
        # dependabot branch we had to fetch), say so.
        if ws.meta.get("source") == "remote":
            sub.send({"type": "notice", "message": f"Fetched origin/{ws.meta.get('branch')} and created the worktree."})
        hub.send(_workspace_list_event(created=ws.id, created_by=sub.presence_id))
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

    if mtype == "teamcity_set_watched_build_types":
        # The UI's ref-counted union of trigger-tile statuses (config id + branch).
        # Fetch + broadcast each immediately so a freshly-mounted tile's LED doesn't
        # wait a poll cycle; the poller keeps them live thereafter.
        async def _set_watched_bt():
            watched = await asyncio.to_thread(
                teamcity_service.set_watched_build_types, msg.get("buildTypes") or [])
            for w in watched:
                build = await asyncio.to_thread(
                    teamcity_service.build_type_status, w["buildTypeId"], w["branch"])
                hub.send({"type": "teamcity_buildtype_status", "buildTypeId": w["buildTypeId"],
                          "branch": w["branch"], "build": build})
        asyncio.create_task(_set_watched_bt())
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
        # Each window sends ITS OWN open docs-explorer/editor dirs; the server watches
        # the UNION across all connections (so one window can't clobber another's — the
        # security boundary is "some open window is showing this dir"). Off-loop I/O.
        sub.watched_docs = set(msg.get("dirs") or [])
        dirs = list(sub.watched_docs)

        async def _apply():
            await asyncio.to_thread(docs_service.set_watched, _watched_docs_union())
            # Always hand THIS window fresh trees for its dirs — set_watched only
            # broadcasts dirs newly-added to the global union, so a window joining a dir
            # another window already watches would otherwise never receive its tree.
            events = await asyncio.to_thread(lambda: [docs_service.tree_event(d) for d in dirs])
            for ev in events:
                sub.send(ev)
        asyncio.create_task(_apply())
        return

    if mtype == "read_file":
        # Read a file for the markdown editor. Confined to a currently-watched docs
        # dir (never arbitrary paths / secrets); replies only to the asking window.
        path = msg.get("path", "")

        def _read():
            if not docs_service.is_allowed(path):
                return {"error": "not permitted"}
            rp = os.path.realpath(os.path.expanduser(path))
            try:
                if os.path.getsize(rp) > 2_000_000:
                    return {"error": "file too large"}
                with open(rp, "r", encoding="utf-8", errors="replace") as fh:
                    return {"content": fh.read()}
            except Exception as e:  # noqa: BLE001
                return {"error": str(e)}

        async def _do_read():
            res = await asyncio.to_thread(_read)
            sub.send({"type": "file_content", "path": path, **res})
        asyncio.create_task(_do_read())
        return

    if mtype == "write_file":
        # Save a file from the markdown editor (atomic write), same confinement.
        path = msg.get("path", "")
        content = msg.get("content", "")

        def _write():
            if not docs_service.is_allowed(path):
                return {"error": "not permitted"}
            rp = os.path.realpath(os.path.expanduser(path))
            try:
                d = os.path.dirname(rp)
                fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(content)
                os.replace(tmp, rp)  # atomic
                return {}
            except Exception as e:  # noqa: BLE001
                return {"error": str(e)}

        async def _do_write():
            res = await asyncio.to_thread(_write)
            sub.send({"type": "file_saved", "path": path, **res})
        asyncio.create_task(_do_write())
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
            # If this was a branch-scoped action (e.g. a trigger tile), re-fetch that
            # branch right away so the queued/running build shows without waiting for
            # the next poll — the tile's status LED updates near-immediately.
            br = msg.get("branch")
            if br:
                rp = msg.get("repo") or ""
                builds = await asyncio.to_thread(teamcity_service.branch_builds, br, rp, 25)
                hub.send({"type": "teamcity_branch_builds", "branch": br, "repo": rp, "builds": builds})
                # Also refresh the triggered config's tile status (precise by id).
                bt_id = msg.get("buildTypeId")
                if bt_id:
                    build = await asyncio.to_thread(teamcity_service.build_type_status, bt_id, br)
                    hub.send({"type": "teamcity_buildtype_status", "buildTypeId": bt_id,
                              "branch": br, "build": build})
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

    if mtype == "slack_sentiment_config":
        # The ✨ Smart toggle + the "what matters to me" note. Persisted server-side,
        # broadcast to every window; editing the note clears the cache (reset) so
        # stale highlights drop. Then score the current poll set immediately so the
        # user doesn't wait a poll cycle for highlights to appear.
        async def _sentiment_cfg():
            reset = sentiment_service.set_config(enabled=msg.get("enabled"), note=msg.get("note"))
            sentiment_service.emit_config(reset)
            if sentiment_service.enabled():
                batch = []
                for ch in slack_service.poll_set():
                    try:
                        msgs = await asyncio.to_thread(slack_service.channel_messages, ch, 30)
                        for m in msgs:
                            batch.append({"channel": ch, "ts": m.get("ts"),
                                          "user": m.get("user"), "text": m.get("text")})
                    except Exception:
                        pass
                await sentiment_service.maybe_score(batch)
        asyncio.create_task(_sentiment_cfg())
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
    sub.presence_id = secrets.token_hex(4)   # stable per-connection id (for presence)
    hub.add(sub)  # receive broadcast state/run events
    drain = asyncio.create_task(_drain(ws, sub))
    # Tell this window its own presence id, then broadcast the updated roster to all.
    sub.send({"type": "presence_self", "id": sub.presence_id})
    hub.send(_presence_event())
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
        hub.send(_presence_event())   # a window left — update everyone's roster
        if getattr(sub, "presence_id", None):
            hub.send({"type": "annotation_clear", "user": sub.presence_id})  # drop their annotations
            hub.send({"type": "doc_awareness_clear", "user": sub.presence_id})  # drop their doc cursor
        # Recompute the watched-docs union without this window (drops its dirs; clears
        # to [] when it was the last one). Other windows keep their dirs watched.
        docs_service.set_watched(_watched_docs_union())
        if hub.empty():
            for ws in workspaces.list():
                run = ws.run
                if run and run.task and not run.task.done():
                    run.task.cancel()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
