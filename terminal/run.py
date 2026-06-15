"""PipelineRun: the state of one pipeline execution, and the event bus its
nodes use.

It wraps the connection's transport (a Subscriber): events the engine and nodes
emit via ``send`` are forwarded to the transport. The agent inboxes, node-output
context, backend choice, and the executing task all live here instead of being
bolted onto the transport with ad-hoc attributes — so a single connection can
hold several independent runs (one per workspace) without them colliding.

Nodes already take a generic ``event_bus`` and only call ``send`` / read
``agent_inboxes`` on it, so a PipelineRun is a drop-in event bus. ``node_backend``
and ``node_outputs`` are this run's config/context, consulted by TerminalNode and
PipelineEngine respectively.
"""


class PipelineRun:
    def __init__(self, transport, node_backend: str = None, workspace_id: str = None):
        self._transport = transport
        # UI backend choice for this run's node sessions ("bare" | "tmux" | None).
        self.node_backend = node_backend
        # Routing key: stamped onto every event so the client routes it to the
        # right workspace tab. None = legacy single-pipeline path (no stamp).
        self.workspace_id = workspace_id
        # node_id -> asyncio.Queue, registered by coordinator agents for steering.
        self.agent_inboxes = {}
        # node_id -> result dict; the run's accumulated output context.
        self.node_outputs = {}
        # node_id -> live session id, so a shared deep-link can resolve a node to
        # its session and attach to it. Learned from node_started events.
        self.node_sessions = {}
        # The asyncio.Task executing this run (set by the caller after create).
        self.task = None

    def send(self, event: dict) -> None:
        """Forward a domain/transport event to the connection transport, stamped
        with this run's workspace_id so the client routes it to the right tab.
        Concurrent runs each have their own bus, so events never cross wires."""
        if event.get("type") == "node_started" and event.get("node_id") is not None and event.get("id"):
            self.node_sessions[event["node_id"]] = event["id"]
        if self.workspace_id is not None:
            event = {**event, "workspace_id": self.workspace_id}
        self._transport.send(event)
