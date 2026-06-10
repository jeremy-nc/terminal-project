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

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from terminal import SessionManager, Subscriber, build_node_tree, PipelineEngine

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "frontend", "dist")


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager.loop = asyncio.get_running_loop()
    yield
    manager.shutdown_all()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def index():
    return FileResponse(os.path.join(DIST, "index.html"))


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
    if ntype in ("terminal", "fanout", "dynamic_batch"):
        # fanout/dynamic_batch children are created at runtime, but the node's
        # own cwd (its template's working dir) can still be validated up front.
        raw = spec.get("cwd")
        if raw:
            resolved = _resolve_cwd(raw, global_cwd)
            if not os.path.isdir(resolved):
                argv_str = " ".join(spec.get("argv", []))
                return f"Working directory does not exist for {argv_str!r}: {resolved!r}"
    elif ntype in ("batch", "sequence"):
        for child in spec.get("nodes", []):
            err = _validate_cwds(child, global_cwd)
            if err:
                return err
    return None


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
        spec = msg.get("pipeline")
        if not spec:
            sub.send({"type": "error", "message": "missing pipeline spec"})
            return
        cwd_error = _validate_cwds(spec)
        if cwd_error:
            sub.send({"type": "error", "message": cwd_error})
            return
        try:
            root = build_node_tree(spec, manager, sub)
        except Exception as e:
            sub.send({"type": "error", "message": f"failed to build pipeline: {e}"})
            return

        initial_input = msg.get("input")
        previous = getattr(sub, "pipeline_task", None)

        async def _run():
            # Cancel any still-running pipeline first so a re-run doesn't leave
            # orphaned PTYs (e.g. an interactive claude) alive in the background.
            # Await its teardown before starting the new run — this also ensures
            # the old run's "pipeline_error" is flushed before the new run's
            # "pipeline_started", so cancellation can't mis-mark the new run.
            if previous and not previous.done():
                previous.cancel()
                try:
                    await previous
                except (asyncio.CancelledError, Exception):
                    pass
            await PipelineEngine(root, sub).execute(initial_input)

        # Track the task on the subscriber so "cancel_pipeline" (and the next
        # run) can cancel it, killing in-flight child PTYs via TerminalNode.
        sub.pipeline_task = asyncio.create_task(_run())
        return

    if mtype == "cancel_pipeline":
        task = getattr(sub, "pipeline_task", None)
        if task and not task.done():
            task.cancel()
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
        manager.detach(sub)
        drain.cancel()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
