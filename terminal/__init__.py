"""Transport-agnostic terminal session domain.

Public API:
  - SessionManager: owns PTY lifecycle and output broadcast.
  - Session:        per-session state (ring buffer, subscribers).
  - Subscriber:     a transport-agnostic consumer of session output.
"""
from .manager import SessionManager
from .session import Session, Subscriber

__all__ = ["SessionManager", "Session", "Subscriber"]
