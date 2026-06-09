"""SessionManager: owns PTY lifecycle and broadcasts output to subscribers.

Depends only on asyncio and the OS; it never imports the transport layer.
Output is delivered to :class:`Subscriber` objects as domain events whose
``data`` field is raw ``bytes``.
"""
import asyncio
import os
import pty
import signal
import uuid

from .pty_utils import resolve_shell, set_winsize
from .session import Session, Subscriber

GRACE_PERIOD = 30  # seconds to wait for reconnect before killing an orphan PTY


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
            self._emit(sess, {"type": "stdout", "id": sess.id, "data": data})

    def _emit(self, sess: Session, event: dict) -> None:
        """Fan an event out to all attached subscribers (non-blocking)."""
        for sub in list(sess.subscribers):
            sub.send(event)

    async def _handle_exit(self, sess: Session) -> None:
        sess.alive = False
        code = None
        try:
            _, status = os.waitpid(sess.pid, 0)
            code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            pass
        self._emit(sess, {"type": "exit", "id": sess.id, "code": code})
        self.sessions.pop(sess.id, None)
        try:
            os.close(sess.fd)
        except OSError:
            pass
        print(f"[sess] exit {sess.id} pid={sess.pid} code={code} (total={len(self.sessions)})", flush=True)

    def attach(self, sess: Session, sub: Subscriber) -> None:
        """Attach a subscriber and cancel any pending grace-period cleanup."""
        if sess.cleanup_task:
            sess.cleanup_task.cancel()
            sess.cleanup_task = None
        sess.subscribers.add(sub)

    def detach(self, sub: Subscriber) -> None:
        """Drop a subscriber from every session; arm grace timers for orphans."""
        for sess in list(self.sessions.values()):
            if sub in sess.subscribers:
                sess.subscribers.discard(sub)
                if not sess.subscribers and sess.alive:
                    sess.cleanup_task = asyncio.create_task(self._grace_kill(sess))

    async def _grace_kill(self, sess: Session) -> None:
        try:
            await asyncio.sleep(GRACE_PERIOD)
        except asyncio.CancelledError:
            return
        if not sess.subscribers and sess.alive:
            self.kill(sess)

    def write(self, sess: Session, data: bytes) -> None:
        """Write bytes to the PTY; silently ignore a just-closed fd."""
        if not sess.alive:
            return
        try:
            os.write(sess.fd, data)
        except OSError:
            pass  # PTY may have just closed; the broadcast loop will send exit

    def resize(self, sess: Session, cols: int, rows: int) -> None:
        if not sess.alive:
            return
        sess.cols, sess.rows = cols, rows
        set_winsize(sess.fd, rows, cols)

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
