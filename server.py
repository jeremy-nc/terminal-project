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
import fcntl
import json
import os
import pty
import shutil
import signal
import struct
import termios
import uuid
from collections import deque
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

MAX_BUFFER_BYTES = 256 * 1024  # per-session ring buffer cap
GRACE_PERIOD = 30  # seconds to wait for reconnect before killing an orphan PTY
HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "frontend", "dist")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(data: str) -> bytes:
    return base64.b64decode(data.encode("ascii"))


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def resolve_shell(name: str) -> list:
    """Resolve a requested shell name to an argv list, falling back to bash."""
    if name == "claude" and shutil.which("claude"):
        return ["claude"]
    return [os.environ.get("SHELL") or "bash"]


class Session:
    def __init__(self, sid, fd, pid, cols, rows):
        self.id = sid
        self.fd = fd
        self.pid = pid
        self.cols = cols
        self.rows = rows
        self.buffer = deque()
        self.buffer_size = 0
        self.queue: asyncio.Queue = asyncio.Queue()
        self.clients = set()  # connected WebSocket objects
        self.alive = True
        self.cleanup_task = None

    def append(self, data: bytes) -> None:
        """Append to the ring buffer, evicting oldest chunks past the cap."""
        self.buffer.append(data)
        self.buffer_size += len(data)
        while self.buffer_size > MAX_BUFFER_BYTES and len(self.buffer) > 1:
            self.buffer_size -= len(self.buffer.popleft())

    def snapshot(self) -> bytes:
        return b"".join(self.buffer)


class SessionManager:
    def __init__(self):
        self.sessions = {}
        self.loop = None

    def create(self, shell_name: str, cols: int, rows: int) -> Session:
        sid = uuid.uuid4().hex[:8]
        argv = resolve_shell(shell_name)
        pid, fd = pty.fork()
        if pid == 0:  # child
            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            try:
                os.execvpe(argv[0], argv, env)
            except FileNotFoundError:
                os.execvpe("bash", ["bash"], env)
            os._exit(1)
        # parent
        set_winsize(fd, rows, cols)
        os.set_blocking(fd, False)
        sess = Session(sid, fd, pid, cols, rows)
        self.sessions[sid] = sess
        self.loop.add_reader(fd, self._on_readable, sess)
        asyncio.create_task(self._broadcast_loop(sess))
        print(f"[sess] create {sid} pid={pid} fd={fd} (total={len(self.sessions)})", flush=True)
        return sess

    def _on_readable(self, sess: Session) -> None:
        """Sync reader registered with the event loop; ordered via the queue."""
        try:
            data = os.read(sess.fd, 65536)
        except OSError:
            data = b""
        if not data:  # EOF: the child has exited
            self.loop.remove_reader(sess.fd)
            sess.queue.put_nowait(None)
            return
        sess.append(data)
        sess.queue.put_nowait(data)

    async def _broadcast_loop(self, sess: Session) -> None:
        while True:
            data = await sess.queue.get()
            if data is None:
                await self._handle_exit(sess)
                return
            await self._send_all(
                sess, {"type": "stdout", "id": sess.id, "data": b64(data)}
            )

    async def _send_all(self, sess: Session, msg: dict) -> None:
        payload = json.dumps(msg)
        dead = []
        for ws in list(sess.clients):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            sess.clients.discard(ws)

    async def _handle_exit(self, sess: Session) -> None:
        sess.alive = False
        code = None
        try:
            _, status = os.waitpid(sess.pid, 0)
            code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            pass
        await self._send_all(sess, {"type": "exit", "id": sess.id, "code": code})
        self.sessions.pop(sess.id, None)
        try:
            os.close(sess.fd)
        except OSError:
            pass
        print(f"[sess] exit {sess.id} pid={sess.pid} code={code} (total={len(self.sessions)})", flush=True)

    def attach(self, sess: Session, ws: WebSocket) -> None:
        """Attach a client and cancel any pending grace-period cleanup."""
        if sess.cleanup_task:
            sess.cleanup_task.cancel()
            sess.cleanup_task = None
        sess.clients.add(ws)

    def detach(self, ws: WebSocket) -> None:
        """Drop a client from every session; arm grace timers for orphans."""
        for sess in list(self.sessions.values()):
            if ws in sess.clients:
                sess.clients.discard(ws)
                if not sess.clients and sess.alive:
                    sess.cleanup_task = asyncio.create_task(self._grace_kill(sess))

    async def _grace_kill(self, sess: Session) -> None:
        try:
            await asyncio.sleep(GRACE_PERIOD)
        except asyncio.CancelledError:
            return
        if not sess.clients and sess.alive:
            self.kill(sess)

    def kill(self, sess: Session) -> None:
        print(f"[sess] kill {sess.id} pid={sess.pid}", flush=True)
        try:
            os.kill(sess.pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    def shutdown_all(self) -> None:
        """Force-kill every child process; used on server shutdown."""
        for sess in list(self.sessions.values()):
            try:
                os.kill(sess.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


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


async def handle_msg(ws: WebSocket, msg: dict) -> None:
    mtype = msg.get("type")
    if mtype == "start":
        sess = manager.create(
            msg.get("shell", "bash"), int(msg["cols"]), int(msg["rows"])
        )
        manager.attach(sess, ws)
        await ws.send_text(
            json.dumps(
                {
                    "type": "started",
                    "id": sess.id,
                    "cid": msg.get("cid"),
                    "cols": sess.cols,
                    "rows": sess.rows,
                }
            )
        )
        return

    sess = manager.sessions.get(msg.get("id"))
    if mtype == "attach":
        if not sess:
            await ws.send_text(json.dumps({"type": "error", "message": "no such session"}))
            return
        manager.attach(sess, ws)
        await ws.send_text(
            json.dumps(
                {
                    "type": "replay",
                    "id": sess.id,
                    "data": b64(sess.snapshot()),
                    "cols": sess.cols,
                    "rows": sess.rows,
                }
            )
        )
    elif mtype == "stdin":
        if sess and sess.alive:
            try:
                os.write(sess.fd, unb64(msg["data"]))
            except OSError:
                pass  # PTY may have just closed; the broadcast loop will send exit
    elif mtype == "resize":
        if sess and sess.alive:
            sess.cols, sess.rows = int(msg["cols"]), int(msg["rows"])
            set_winsize(sess.fd, sess.rows, sess.cols)
    elif mtype == "close":
        if sess:
            manager.kill(sess)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            try:
                raw = await ws.receive_text()
                msg = json.loads(raw)
            except json.JSONDecodeError as e:
                await ws.send_text(json.dumps({"type": "error", "message": f"bad json: {e}"}))
                continue
            try:
                await handle_msg(ws, msg)
            except Exception as e:
                # Log and tell the client, but keep the connection alive.
                print(f"[ws] handle_msg error: {e!r}")
                await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
    except WebSocketDisconnect:
        manager.detach(ws)
    except Exception as e:
        print(f"[ws] fatal error: {e!r}")
        manager.detach(ws)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
