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
from typing import Any
from contextlib import asynccontextmanager

from dotenv import load_dotenv

# Load .env before anything reads the environment (e.g. ANTHROPIC_API_KEY for
# Agent nodes). Values already set in the real environment take precedence.
load_dotenv()

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from terminal import (
    SessionManager, Subscriber, build_node_tree, PipelineEngine, PipelineRun,
    WorkspaceStore,
)
from terminal.workspace_kinds import get_kind, kinds_manifest, WorkspaceError

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "frontend", "dist")
WORKSPACES_FILE = os.path.join(HERE, "workspaces.json")


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
hub = Hub()

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


def _workspace_list_event(created: str = None) -> dict:
    return {
        "type": "workspace_list",
        "workspaces": [w.to_json() for w in workspaces.list()],
        "created": created,
        # Kind manifest so the create modal can render kind-agnostically.
        "kinds": kinds_manifest(),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager.loop = asyncio.get_running_loop()
    # Kill any stale tmux server so sessions started by this run pick up the
    # current tmux.conf (tmux only reads its config when the server starts).
    manager.reset_backend()
    yield
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


# Shared deep-links (/shared/workspace/{id}/t/{nodeId}) are client-side routes,
# so serve the SPA shell for any /shared/* path; the frontend reads the URL.
@app.get("/shared/{rest:path}")
async def shared(rest: str):
    return FileResponse(
        os.path.join(DIST, "index.html"),
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


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
        try:
            ws = workspaces.create(kind_id, fields, name=msg.get("name"))
        except WorkspaceError as e:
            sub.send({"type": "error", "message": str(e)})
            return
        hub.send(_workspace_list_event(created=ws.id))
        return

    if mtype == "set_pipeline":
        workspaces.set_pipeline(msg.get("workspace_id"), msg.get("dsl", ""))
        hub.send(_workspace_list_event())
        return

    if mtype == "delete_workspace":
        wid = msg.get("workspace_id")
        ws = workspaces.get(wid)
        if ws is None:
            return
        # Stop any in-flight run first (frees the worktree, kills child PTYs).
        if ws.run is not None and ws.run.task is not None and not ws.run.task.done():
            ws.run.task.cancel()
        # The client decides per-close whether to tear down a worktree ("ask each
        # time"). cleanup is safe by default (git refuses on uncommitted changes);
        # if it refuses and the user hasn't opted to force, KEEP the workspace so
        # they can retry with Force or choose Keep — and tell the closer why.
        if msg.get("remove_resources"):
            warnings = get_kind(ws.kind).cleanup(ws.meta, force=bool(msg.get("force")))
            if warnings and not msg.get("force"):
                sub.send({"type": "workspace_cleanup_blocked", "workspace_id": wid, "message": warnings[0]})
                return
        workspaces.delete(wid)
        hub.send(_workspace_list_event())
        return

    sess = manager.sessions.get(msg.get("id"))
    if mtype == "attach":
        if not sess:
            sub.send({"type": "error", "message": "no such session"})
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
            for ws in workspaces.list():
                run = ws.run
                if run and run.task and not run.task.done():
                    run.task.cancel()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
