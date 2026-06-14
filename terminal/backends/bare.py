"""Bare-PTY backend: a direct ``pty.fork`` + ``execvpe`` of the shell.

This is the original (pre-tmux) terminal backing, preserved behind the
:class:`~terminal.backends.base.TerminalBackend` port. The child execs ``argv``
directly, so the PTY is wired straight to the shell and its output is the
command's raw stdout — which is why pipeline nodes (whose output is piped
downstream) always use this backend.

Because a bare PTY can't be shared with another terminal emulator,
``native_handoff`` opens a *fresh* shell at the session's current working
directory rather than re-attaching the live one.
"""
import os
import signal
import subprocess

from ..pty_utils import fork_pty
from .macos import open_terminal_at


def _live_cwd(pid: int) -> str:
    """Best-effort current working directory of the shell ``pid`` (macOS has no
    /proc, so query lsof). Returns None if it can't be determined."""
    try:
        out = subprocess.run(
            ["lsof", "-a", "-d", "cwd", "-Fn", "-p", str(pid)],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return None
    for line in out.stdout.splitlines():
        if line.startswith("n"):  # lsof -F 'n' field = the file name (the cwd)
            return line[1:]
    return None


class BarePtyBackend:
    name = "bare"

    def spawn(self, sid, argv, cols, rows, cwd=None):
        return fork_pty(argv, cols, rows, cwd)

    def kill(self, sess):
        try:
            os.kill(sess.pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    def shutdown(self, sess):
        try:
            os.kill(sess.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def native_handoff(self, sess):
        open_terminal_at(_live_cwd(sess.pid))

    # A bare PTY's output IS the command's clean stdout, so no side-tap is
    # needed: spawn normally and tell the caller (read_capture -> None) to use
    # the PTY stream it already collects.
    def spawn_captured(self, sid, argv, cols, rows, cwd=None):
        return self.spawn(sid, argv, cols, rows, cwd)

    def read_capture(self, sess):
        return None

    def end_capture(self, sess):
        pass

    def reset_server(self):
        pass  # no shared server
