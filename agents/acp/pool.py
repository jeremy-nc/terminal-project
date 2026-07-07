"""AcpPool: owns the ACP agent subprocesses for one pipeline run. One client
(process) per ``(agent, cwd)`` — reused across sessions — so a run that runs
several ACP nodes in the same worktree shares one warm agent, and closing the run
kills them all. Owned by the PipelineRun (``run.acp``)."""
import os
import sys

from .client import AcpClient

_STUB = os.path.join(os.path.dirname(__file__), "stub_agent.py")

# ACP protocol version + the client capabilities we actually serve: filesystem
# (confined to the node's cwd by the fs handlers) and terminal (commands run as
# our child processes, captured headlessly).
_PROTOCOL_VERSION = 1
_CLIENT_CAPS = {"fs": {"readTextFile": True, "writeTextFile": True}, "terminal": True}


def resolve_agent_argv(agent: str) -> list:
    """Map an agent name to the argv that launches its ACP server."""
    if agent in (None, "", "stub"):
        return [sys.executable, _STUB]              # the built-in test agent
    if agent == "claude-code":
        return ["claude-code-acp"]                  # needs the wrapper on PATH + ANTHROPIC_API_KEY
    if agent == "gemini":
        return ["gemini", "--experimental-acp"]
    if agent == "hermes":
        # Nous Research Hermes as an ACP stdio server (the Zed-registry launch).
        # uvx fetches hermes-agent[acp] on demand; needs Nous Portal auth to run.
        return ["uvx", "--from", "hermes-agent[acp]", "hermes-acp"]
    return [agent]                                  # explicit binary name


class AcpPool:
    def __init__(self):
        self._clients = {}                          # (agent, cwd) -> AcpClient

    async def get(self, agent: str, cwd: str) -> AcpClient:
        key = (agent, cwd)
        client = self._clients.get(key)
        if client is None:
            client = AcpClient(resolve_agent_argv(agent), cwd)
            await client.start()
            await client.request("initialize", {
                "protocolVersion": _PROTOCOL_VERSION,
                "clientCapabilities": _CLIENT_CAPS,
            })
            self._clients[key] = client
        return client

    async def close(self) -> None:
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            try:
                await client.close()
            except Exception:                       # noqa: BLE001 — best-effort teardown
                pass
