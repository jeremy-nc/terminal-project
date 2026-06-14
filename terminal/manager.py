"""SessionManager: owns PTY lifecycle and broadcasts output to subscribers.

Depends only on asyncio and the OS; it never imports the transport layer.
Output is delivered to :class:`Subscriber` objects as domain events whose
``data`` field is raw ``bytes``.
"""
import asyncio
import os
import uuid

from .pty_utils import resolve_shell, set_winsize
from .session import Session, Subscriber
from .backends import make_backend

GRACE_PERIOD = 30  # seconds to wait for reconnect before killing an orphan PTY


class SessionManager:
    def __init__(self, backend=None):
        self.sessions = {}
        self.loop = None
        # All sessions use the configured backend (tmux when available, so they
        # can be handed off to a native Terminal as a shared session). Pipeline
        # nodes additionally pass create(capture=True): the coordinator pipes
        # their stdout downstream, and tmux's PTY stream is a rendered screen,
        # so the backend sets up a clean side-tap (read via read_capture). Each
        # session remembers its backend so kill/shutdown/handoff/capture route
        # correctly. Only spawning and termination touch a backend; the read
        # loop, buffer, broadcast, resize, and grace-kill below are
        # backend-agnostic.
        self._backend = backend or make_backend()

    def reset_backend(self) -> None:
        """Discard stale backend state (e.g. a leftover tmux server) so sessions
        pick up the current config. Call once on server startup."""
        self._backend.reset_server()

    def create(self, shell_name: str = None, cols: int = 80, rows: int = 24, argv: list = None, cwd: str = None, capture: bool = False) -> Session:
        sid = uuid.uuid4().hex[:8]
        if not argv:
            argv = resolve_shell(shell_name or "bash")
        backend = self._backend
        if capture:
            pid, fd = backend.spawn_captured(sid, argv, cols, rows, cwd)
        else:
            pid, fd = backend.spawn(sid, argv, cols, rows, cwd)
        sess = Session(sid, fd, pid, cols, rows)
        sess.backend = backend
        self.sessions[sid] = sess
        self.loop.add_reader(fd, self._on_readable, sess)
        asyncio.create_task(self._broadcast_loop(sess))
        print(f"[sess] create {sid} pid={pid} fd={fd} (total={len(self.sessions)})", flush=True)
        return sess

    def create_virtual(self, cols: int = 80, rows: int = 24) -> Session:
        """A session with no PTY: a producer (e.g. an SDK agent loop) writes
        text via ``feed`` and it buffers/broadcasts exactly like a real PTY, so
        it renders in a terminal card. Finish it with ``finish_virtual``."""
        sid = uuid.uuid4().hex[:8]
        sess = Session(sid, None, None, cols, rows)
        sess.backend = None  # virtual: no process, never handed to a backend
        self.sessions[sid] = sess
        asyncio.create_task(self._broadcast_loop(sess))
        print(f"[sess] create-virtual {sid} (total={len(self.sessions)})", flush=True)
        return sess

    def feed(self, sess: Session, data: bytes) -> None:
        """Push producer output into a virtual session (buffer + broadcast)."""
        if not sess.alive:
            return
        sess.append(data)
        sess.queue.put_nowait(data)

    def finish_virtual(self, sess: Session) -> None:
        """Signal end-of-output for a virtual session (emits exit + cleanup)."""
        sess.queue.put_nowait(None)

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
        if sess.pid is not None:  # real PTY — reap the child
            try:
                _, status = os.waitpid(sess.pid, 0)
                code = os.waitstatus_to_exitcode(status)
            except ChildProcessError:
                pass
        self._emit(sess, {"type": "exit", "id": sess.id, "code": code})
        self.sessions.pop(sess.id, None)
        if sess.fd is not None:
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
        if not sess.alive or sess.fd is None:
            return  # virtual sessions have no PTY to write to
        try:
            os.write(sess.fd, data)
        except OSError:
            pass  # PTY may have just closed; the broadcast loop will send exit

    def resize(self, sess: Session, cols: int, rows: int) -> None:
        if not sess.alive or sess.fd is None:
            return
        sess.cols, sess.rows = cols, rows
        set_winsize(sess.fd, rows, cols)

    def kill(self, sess: Session) -> None:
        print(f"[sess] kill {sess.id} pid={sess.pid}", flush=True)
        if sess.pid is None:  # virtual — just signal end-of-output
            if sess.alive:
                sess.queue.put_nowait(None)
            return
        sess.backend.kill(sess)

    def open_in_terminal(self, sess: Session) -> None:
        """Launch this session in the native macOS Terminal via its backend's
        handoff strategy (true re-attach under tmux; fresh shell at cwd under
        the bare backend)."""
        sess.backend.native_handoff(sess)

    def read_capture(self, sess: Session):
        """Clean stdout of a captured (pipeline) session, or None to fall back
        to the PTY broadcast stream (bare backend)."""
        return sess.backend.read_capture(sess) if sess.backend else None

    def end_capture(self, sess: Session) -> None:
        """Release a captured session's side-tap resources."""
        if sess.backend:
            sess.backend.end_capture(sess)

    def shutdown_all(self) -> None:
        """Force-kill every child process; used on server shutdown."""
        for sess in list(self.sessions.values()):
            if sess.pid is None:
                continue
            sess.backend.shutdown(sess)
