"""Pluggable terminal backends (the process-backing port + adapters).

  - TerminalBackend: the port — how a session's real process is spawned/killed
                     and handed off to a native terminal.
  - BarePtyBackend:  the original direct ``pty.fork`` + shell exec.
  - TmuxBackend:     sessions inside an isolated tmux server (shareable with a
                     native Terminal window).
  - make_backend():  pick the interactive backend (env override, else auto).
"""
import os
import shutil

from .base import TerminalBackend
from .bare import BarePtyBackend
from .tmux import TmuxBackend


def make_backend():
    """Select the interactive-tab backend.

    ``NCT_TERMINAL_BACKEND=bare|tmux`` forces a choice; otherwise use tmux when
    it's on PATH (so 'open in Terminal' becomes a true shared session), falling
    back to the bare PTY when it isn't.
    """
    choice = (os.environ.get("NCT_TERMINAL_BACKEND") or "").strip().lower()
    if choice == "bare":
        return BarePtyBackend()
    if choice == "tmux":
        return TmuxBackend()
    return TmuxBackend() if shutil.which("tmux") else BarePtyBackend()


__all__ = ["TerminalBackend", "BarePtyBackend", "TmuxBackend", "make_backend"]
