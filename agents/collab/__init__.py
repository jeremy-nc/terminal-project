"""Collab domain: the runtime for a Collab workspace — one ACP agent process,
many live sessions (panels) added dynamically, with a shared multi-user chat."""
from .run import CollabRun

__all__ = ["CollabRun"]
