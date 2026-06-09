import asyncio
import os
from typing import Any, List, Optional, Callable
from .manager import SessionManager
from .session import Subscriber


class Node:
    """Abstract base class for a coordination node."""

    async def run(self, input_data: Any) -> Any:
        raise NotImplementedError


class CollectorSubscriber(Subscriber):
    """A subscriber that accumulates stdout and resolves on exit."""

    def __init__(self, idle_timeout: float = 1.5):
        super().__init__()
        self.output = bytearray()
        self.exit_code = None
        self.exit_future = asyncio.Future()
        self.session_id = None
        self.idle_timeout = idle_timeout
        self.last_output_time = asyncio.get_event_loop().time()
        self.prompt_patterns = [b"> ", b"$ ", b"? ", b": ", b"] "]
        self.is_paused = False

    def send(self, event: dict) -> None:
        etype = event.get("type")
        if etype == "stdout":
            self.output.extend(event["data"])
            self.last_output_time = asyncio.get_event_loop().time()
            self.is_paused = False
        elif etype == "exit":
            self.exit_code = event.get("code")
            if not self.exit_future.done():
                self.exit_future.set_result(True)
        elif etype == "started":
            self.session_id = event.get("id")
        super().send(event)

    def check_pause(self) -> bool:
        """Heuristic check: quiet for N seconds and ends in a prompt."""
        if self.is_paused or self.exit_future.done():
            return False
        now = asyncio.get_event_loop().time()
        if now - self.last_output_time < self.idle_timeout:
            return False

        # Must end in a common prompt pattern
        if not self.output:
            return False
        tail = self.output[-5:]
        if any(tail.endswith(p) for p in self.prompt_patterns):
            self.is_paused = True
            return True
        return False

    async def wait_for_exit(self, on_pause: Callable = None):
        """Wait for exit, occasionally checking for pauses if on_pause provided."""
        while not self.exit_future.done():
            try:
                await asyncio.wait_for(asyncio.shield(self.exit_future), timeout=0.5)
            except asyncio.TimeoutError:
                if on_pause and self.check_pause():
                    await on_pause(self)

        return bytes(self.output), self.exit_code


class TerminalNode(Node):
    """Runs a single terminal command to completion."""

    def __init__(
        self,
        manager: SessionManager,
        argv_template: List[str],
        cols: int = 80,
        rows: int = 24,
        event_bus: Subscriber = None,
        node_id: Any = None,
        cwd: str = None,
    ):
        self.manager = manager
        self.argv_template = argv_template
        self.cols = cols
        self.rows = rows
        self.event_bus = event_bus
        # Spec id from the DSL, echoed back in events so the client can overlay
        # live status/session onto the correct node in the pipeline tree.
        self.node_id = node_id
        self.cwd = cwd
        self.current_session_id = None

    async def run(self, input_data: Any) -> Any:
        # Simple templating: replace {{input}} in argv strings
        argv = [
            arg.replace("{{input}}", str(input_data)) for arg in self.argv_template
        ]

        sub = CollectorSubscriber()
        sess = self.manager.create(cols=self.cols, rows=self.rows, argv=argv, cwd=self.cwd)
        self.current_session_id = sess.id
        self.manager.attach(sess, sub)

        # Notify the bus that we started a terminal
        if self.event_bus:
            self.event_bus.send({
                "type": "node_started",
                "node_type": "terminal",
                "id": sess.id,
                "node_id": self.node_id,
                "argv": argv
            })

        async def _on_pause(csub: CollectorSubscriber):
            if self.event_bus:
                self.event_bus.send({
                    "type": "needs_input",
                    "id": sess.id,
                    "node_id": self.node_id,
                    "last_output": bytes(csub.output[-100:]) # last 100 bytes for context
                })

        output, code = await sub.wait_for_exit(on_pause=_on_pause)

        result = {"output": output, "exit_code": code}
        if self.event_bus:
            self.event_bus.send({
                "type": "node_finished",
                "id": sess.id,
                "node_id": self.node_id,
                "exit_code": code
            })
        return result


class BatchNode(Node):
    """Runs multiple nodes concurrently (Map-Reduce)."""

    def __init__(self, nodes: List[Node], concurrency: Optional[int] = None, event_bus: Subscriber = None):
        self.nodes = nodes
        # None (or non-positive) means "no cap": run every node concurrently.
        if not concurrency or concurrency < 1:
            concurrency = max(len(nodes), 1)
        self.semaphore = asyncio.Semaphore(concurrency)
        self.event_bus = event_bus

    async def run(self, input_list: Any) -> List[Any]:
        if not isinstance(input_list, list):
            input_list = [input_list] * len(self.nodes)

        if self.event_bus:
            self.event_bus.send({"type": "node_started", "node_type": "batch", "count": len(self.nodes)})

        async def _run_one(node, data):
            async with self.semaphore:
                return await node.run(data)

        tasks = [_run_one(node, data) for node, data in zip(self.nodes, input_list)]
        results = await asyncio.gather(*tasks)

        if self.event_bus:
            self.event_bus.send({"type": "node_finished", "node_type": "batch"})
        return results


class SequenceNode(Node):
    """Pipes output of one node as input to the next (Pipeline)."""

    def __init__(self, nodes: List[Node], event_bus: Subscriber = None):
        self.nodes = nodes
        self.event_bus = event_bus

    async def run(self, input_data: Any) -> Any:
        current = input_data
        if self.event_bus:
            self.event_bus.send({"type": "node_started", "node_type": "sequence", "count": len(self.nodes)})

        for i, node in enumerate(self.nodes):
            current = await node.run(current)

        if self.event_bus:
            self.event_bus.send({"type": "node_finished", "node_type": "sequence"})
        return current


class PipelineEngine:
    """Entry point for running a composed pipeline and watching its progress."""

    def __init__(self, root_node: Node, sub: Subscriber):
        self.root_node = root_node
        self.sub = sub

    async def execute(self, initial_input: Any = None):
        self.sub.send({"type": "pipeline_started"})
        try:
            result = await self.root_node.run(initial_input)
            self.sub.send({"type": "pipeline_finished", "result": result})
            return result
        except Exception as e:
            self.sub.send({"type": "pipeline_error", "message": str(e)})
            raise



def _resolve_cwd(raw: str, global_cwd: str) -> str:
    """
    Expand ~ and resolve relative paths.
    Relative paths are resolved against global_cwd if set, else the server cwd.
    """
    expanded = os.path.expanduser(raw)
    if not os.path.isabs(expanded):
        base = global_cwd if global_cwd else os.getcwd()
        expanded = os.path.join(base, expanded)
    return os.path.normpath(expanded)


def build_node_tree(
    spec: dict,
    manager: SessionManager,
    event_bus: Subscriber,
    _global_cwd: str = None,
) -> Node:
    """Recursively build a Node tree from a JSON-serializable spec.

    cwd propagation rules:
      - The root spec may carry a 'cwd' field (from 'dir:' in the DSL) — this
        becomes the global default for all descendant leaf nodes.
      - Each node may carry its own 'cwd' field (from a trailing '@path' in the
        DSL) — this overrides the inherited global for that leaf only.
      - Relative paths are resolved against the global cwd if set, else the
        server's cwd (repo root).  '~' is expanded to $HOME.
    """
    # The root sequence node may carry the global dir.
    if spec.get("type") == "sequence" and spec.get("id") == "root" and spec.get("cwd"):
        _global_cwd = _resolve_cwd(spec["cwd"], None)

    ntype = spec.get("type")
    if ntype == "terminal":
        raw_cwd = spec.get("cwd")
        resolved = _resolve_cwd(raw_cwd, _global_cwd) if raw_cwd else _global_cwd
        return TerminalNode(
            manager=manager,
            argv_template=spec["argv"],
            cols=spec.get("cols", 80),
            rows=spec.get("rows", 24),
            event_bus=event_bus,
            node_id=spec.get("id"),
            cwd=resolved,
        )
    elif ntype == "batch":
        nodes = [build_node_tree(n, manager, event_bus, _global_cwd) for n in spec["nodes"]]
        return BatchNode(nodes, concurrency=spec.get("concurrency"), event_bus=event_bus)
    elif ntype == "sequence":
        nodes = [build_node_tree(n, manager, event_bus, _global_cwd) for n in spec["nodes"]]
        return SequenceNode(nodes, event_bus=event_bus)
    else:
        raise ValueError(f"Unknown node type: {ntype}")
