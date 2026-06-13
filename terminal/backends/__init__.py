"""Pluggable terminal backends (the process-backing port + adapters).

  - TerminalBackend: the port — how a session's real process is spawned/killed.
  - BarePtyBackend:  the original direct ``pty.fork`` + shell exec.
"""
from .base import TerminalBackend
from .bare import BarePtyBackend

__all__ = ["TerminalBackend", "BarePtyBackend"]
