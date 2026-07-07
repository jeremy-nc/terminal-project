"""ACP (Agent Client Protocol) domain: drive coding-agent subprocesses over
JSON-RPC 2.0 stdio. Decoupled from the pipeline engine — the AcpNode in
terminal/coordinator.py is the only consumer."""
from .client import AcpClient
from .pool import AcpPool, resolve_agent_argv
from .session import AcpSession
from .terminal import AcpTerminal, spawn_terminal
from .transcript import Transcript, feed_text, text_of

__all__ = ["AcpClient", "AcpPool", "resolve_agent_argv", "Transcript", "feed_text",
           "text_of", "AcpTerminal", "spawn_terminal", "AcpSession"]
