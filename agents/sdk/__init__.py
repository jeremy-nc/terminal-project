"""Claude Agent SDK domain: drive Claude Code as a library (in-process, via the
``claude-agent-sdk`` package) instead of over ACP. An :class:`SdkSession` mirrors
the AcpSession interface (open/prompt/set_mode/set_model/cancel/close + record_*)
and emits the SAME websocket event contract, so a Collab panel can be backed by
either technology without the frontend or CollabRun caring which."""
from .session import SdkSession, make_delegate_server

__all__ = ["SdkSession", "make_delegate_server"]
