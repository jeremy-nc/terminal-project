"""Terminal backend port: the swappable strategy for how a session's
underlying process is spawned and terminated.

Only the OS / process-backing concerns live behind this port. The session
ring buffer, subscriber fan-out, PTY read loop, resize ioctl, and
grace-period cleanup are backend-agnostic and remain in
:class:`~terminal.manager.SessionManager`.

A backend deals exclusively with *real* PTY-backed sessions. Virtual
sessions (SDK-agent loops with no process) never reach a backend — the
manager handles their lifecycle directly.
"""
from typing import Protocol, Tuple


class TerminalBackend(Protocol):
    """Strategy for spawning and terminating a session's real process."""

    name: str

    def spawn(self, sid: str, argv: list, cols: int, rows: int, cwd: str = None) -> Tuple[int, int]:
        """Fork a PTY running ``argv`` (chdir'd to ``cwd`` if given) and return
        ``(pid, master_fd)``. The returned fd is sized to ``cols``/``rows`` and
        set non-blocking before return."""
        ...

    def kill(self, sess) -> None:
        """Terminate the session's process (graceful, e.g. SIGHUP)."""
        ...

    def shutdown(self, sess) -> None:
        """Force-kill the session's process on server shutdown (e.g. SIGKILL)."""
        ...

    def native_handoff(self, sess) -> None:
        """Open this session in the native (macOS) Terminal. What this means is
        backend-specific: a multiplexed backend re-attaches the *same* live
        session; a bare backend opens a fresh shell at its working directory.
        Raises on failure (e.g. unsupported platform)."""
        ...
