"""Transport-agnostic terminal session domain.

Public API:
  - SessionManager: owns PTY lifecycle and output broadcast.
  - Session:        per-session state (ring buffer, subscribers).
  - Subscriber:     a transport-agnostic consumer of session output.
"""
from .manager import SessionManager
from .session import Session, Subscriber
from .coordinator import build_node_tree, PipelineEngine

__all__ = ["SessionManager", "Session", "Subscriber", "build_node_tree", "PipelineEngine"]
