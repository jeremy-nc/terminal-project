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


manager = SessionManager()
workspaces = WorkspaceStore(WORKSPACES_FILE)


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


def _sub_runs(sub: Subscriber) -> dict:
    """The connection's workspace runs, keyed by workspace_id (lazily created)."""
    runs = getattr(sub, "runs", None)
    if runs is None:
        runs = sub.runs = {}
    return runs


def _start_pipeline(sub, spec, backend, initial_input, workspace_id, previous):
    """Validate, build, and kick off a pipeline run as a task. Returns the
    PipelineRun (task set), or None if validation/build failed (error sent)."""
    cwd_error = _validate_cwds(spec)
    if cwd_error:
        sub.send({"type": "error", "message": cwd_error})
        return None
    run = PipelineRun(sub, node_backend=backend, workspace_id=workspace_id)
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


def _send_workspaces(sub: Subscriber, created: str = None) -> None:
    """Send the full workspace list (definitions). ``created`` flags a just-made
    one so the client can auto-select it."""
    sub.send({
        "type": "workspace_list",
        "workspaces": [w.to_json() for w in workspaces.list()],
        "created": created,
    })


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
        run = _start_pipeline(sub, spec, msg.get("backend"), msg.get("input"),
                              workspace_id=None, previous=getattr(sub, "run", None))
        if run is not None:
            sub.run = run
        return

    if mtype == "run_workspace":
        # Concurrent path: each workspace has its own keyed run, so running one
        # doesn't cancel the others. Re-running the SAME workspace overrides its
        # context (cancels its prior run).
        wid = msg.get("workspace_id")
        ws = workspaces.get(wid)
        if not ws:
            sub.send({"type": "error", "message": "no such workspace"})
            return
        spec = msg.get("pipeline")
        if not spec:
            sub.send({"type": "error", "message": "missing pipeline spec"})
            return
        runs = _sub_runs(sub)
        run = _start_pipeline(sub, spec, msg.get("backend"), msg.get("input"),
                              workspace_id=wid, previous=runs.get(wid))
        if run is not None:
            runs[wid] = run
            ws.run = run  # workspace owns its latest run/context
        return

    if mtype in ("cancel_pipeline", "cancel_workspace"):
        wid = msg.get("workspace_id")
        run = _sub_runs(sub).get(wid) if wid else getattr(sub, "run", None)
        if run and run.task and not run.task.done():
            run.task.cancel()
        return

    if mtype == "node_input":
        # User steering for a running coordinator agent — route to its inbox.
        # workspace_id disambiguates which run owns the node (ids can repeat
        # across workspaces); falls back to the legacy single run.
        wid = msg.get("workspace_id")
        run = _sub_runs(sub).get(wid) if wid else getattr(sub, "run", None)
        inbox = run.agent_inboxes.get(msg.get("node_id")) if run else None
        if inbox is not None:
            inbox.put_nowait(msg.get("text", ""))
        return

    # ── Workspace CRUD (each op replies with the full list, the client's
    #    single source of truth for "what sessions exist") ───────────────────
    if mtype == "list_workspaces":
        _send_workspaces(sub)
        return

    if mtype == "create_workspace":
        raw_dir = (msg.get("dir") or "").strip()
        if not raw_dir:
            sub.send({"type": "error", "message": "workspace requires a directory"})
            return
        resolved = _resolve_cwd(raw_dir, None)
        if not os.path.isdir(resolved):
            sub.send({"type": "error", "message": f"directory does not exist: {resolved}"})
            return
        ws = workspaces.create(raw_dir, msg.get("name"))
        _send_workspaces(sub, created=ws.id)
        return

    if mtype == "set_pipeline":
        workspaces.set_pipeline(msg.get("workspace_id"), msg.get("dsl", ""))
        _send_workspaces(sub)
        return

    if mtype == "delete_workspace":
        workspaces.delete(msg.get("workspace_id"))
        _send_workspaces(sub)
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
                "data": sess.snapshot(),
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
        # Cancel every in-flight run (legacy single + all workspace runs) so a
        # disconnect doesn't leave a coordinator looping (spending API credits),
        # children running, or an ask_user wait blocked forever. Cancellation
        # kills child PTYs and runs each node's cleanup (inbox unregister,
        # finish_virtual).
        active = [getattr(sub, "run", None), *getattr(sub, "runs", {}).values()]
        for r in active:
            if r and r.task and not r.task.done():
                r.task.cancel()
        manager.detach(sub)
        drain.cancel()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
