import asyncio
import json
import os
import re
from typing import Any, List, Optional, Callable
from .manager import SessionManager
from .session import Subscriber

# Matches ANSI/VT escape sequences so PTY output can be cleaned before it is
# piped into a downstream node as {{input}} or rendered as a final result.
# Covers CSI (ESC[...), OSC (ESC]...BEL/ST), and the nF/Fp/Fe single-final
# escapes (charset designation like ESC(B, keypad modes like ESC=, etc.).
_ANSI_RE = re.compile(
    rb"\x1b\[[0-?]*[ -/]*[@-~]"            # CSI  (incl. private params <=>?)
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC  (terminated by BEL or ST)
    rb"|\x1b[ -/]*[0-~]"                    # nF / charset / keypad / Fe escapes
)


def _strip_ansi(data: bytes) -> bytes:
    return _ANSI_RE.sub(b"", data)


def _decode_output(result: Any) -> Optional[str]:
    """Decode a single node result dict's ``output`` (bytes) to clean text.
    Strips ANSI and normalises PTY carriage returns. Returns None if ``result``
    isn't a node result dict."""
    if isinstance(result, dict) and "output" in result:
        out = result["output"]
        if isinstance(out, (bytes, bytearray)):
            text = _strip_ansi(bytes(out)).decode("utf-8", "replace")
            return text.replace("\r\n", "\n").replace("\r", "")
        return str(out)
    return None


def render_input(input_data: Any) -> str:
    """Render a node's input for {{input}} substitution.

    - None                -> "" (e.g. the very first stage)
    - a node result dict  -> its decoded stdout
    - a list of results   -> each decoded stdout, newline-joined (fan-out reduce)
    - a plain string/list item -> itself
    """
    if input_data is None:
        return ""
    if isinstance(input_data, list):
        parts = []
        for item in input_data:
            decoded = _decode_output(item)
            parts.append((decoded if decoded is not None else str(item)).rstrip())
        return "\n".join(parts)
    decoded = _decode_output(input_data)
    return decoded if decoded is not None else str(input_data)


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
        parent_id: Any = None,
        internal: bool = False,
        outputs: dict = None,
    ):
        self.manager = manager
        self.argv_template = argv_template
        self.cols = cols
        self.rows = rows
        self.event_bus = event_bus
        # Shared, coordinator-owned map (node_id -> result) collected as nodes
        # finish, so the whole pipeline's outputs survive to pipeline_finished.
        self.outputs = outputs
        # Spec id from the DSL, echoed back in events so the client can overlay
        # live status/session onto the correct node in the pipeline tree.
        self.node_id = node_id
        # For runtime-spawned children (fan-out), the id of the node they live
        # under. The client nests their live cards beneath that parent.
        self.parent_id = parent_id
        # Internal plumbing nodes (e.g. the dynamic-batch structurer) run as
        # real PTYs but should not be surfaced as cards in the UI.
        self.internal = internal
        self.cwd = cwd
        self.current_session_id = None

    async def run(self, input_data: Any) -> Any:
        # Templating: replace {{input}} with the decoded upstream output.
        rendered = render_input(input_data)
        argv = [arg.replace("{{input}}", rendered) for arg in self.argv_template]

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
                "parent_id": self.parent_id,
                "internal": self.internal,
                "argv": argv
            })

        async def _on_pause(csub: CollectorSubscriber):
            if self.event_bus:
                self.event_bus.send({
                    "type": "needs_input",
                    "id": sess.id,
                    "node_id": self.node_id,
                    "parent_id": self.parent_id,
                    "last_output": bytes(csub.output[-100:]) # last 100 bytes for context
                })

        try:
            output, code = await sub.wait_for_exit(on_pause=_on_pause)
        except asyncio.CancelledError:
            # Pipeline was cancelled: terminate the in-flight PTY before unwinding.
            self.manager.kill(sess)
            raise

        result = {"output": output, "exit_code": code}
        # Record into the coordinator's map (skip internal plumbing like the
        # structurer). No race: captured in-process the moment we finish.
        if self.outputs is not None and not self.internal and self.node_id is not None:
            self.outputs[self.node_id] = result
        if self.event_bus:
            finished = {
                "type": "node_finished",
                "id": sess.id,
                "node_id": self.node_id,
                "parent_id": self.parent_id,
                "exit_code": code,
            }
            # Carry the captured output so the client can fill its per-node view
            # as each node finishes (skip internal plumbing like the structurer).
            if not self.internal:
                finished["output"] = output
            self.event_bus.send(finished)
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


DEFAULT_FANOUT_CAP = 8


class FanOutNode(Node):
    """Data-driven fan-out: spawns one terminal per input item (or N identical
    terminals when ``count`` is set), all running the same command template.

    Children are created at *runtime* — their number isn't known until the
    seed list arrives — so they're announced lazily via per-child node events
    rather than from the static spec tree. Failures are best-effort: a child
    that raises becomes an error result rather than killing the whole fan-out.
    """

    def __init__(
        self,
        manager: SessionManager,
        argv_template: List[str],
        cols: int = 80,
        rows: int = 24,
        event_bus: Subscriber = None,
        node_id: Any = None,
        cwd: str = None,
        cap: int = DEFAULT_FANOUT_CAP,
        count: Optional[int] = None,
        outputs: dict = None,
    ):
        self.manager = manager
        self.argv_template = argv_template
        self.cols = cols
        self.rows = rows
        self.event_bus = event_bus
        self.node_id = node_id
        self.cwd = cwd
        self.outputs = outputs
        self.cap = cap if cap and cap > 0 else DEFAULT_FANOUT_CAP
        # Authored count (e.g. dyn_batch(8): ...) -> broadcast the input to N
        # identical children. None -> derive the children from the input list.
        self.count = count

    def _resolve_items(self, input_data: Any) -> List[Any]:
        if self.count is not None:
            return [input_data] * self.count
        if isinstance(input_data, list):
            return list(input_data)
        return [input_data]

    async def run(self, input_data: Any) -> List[Any]:
        items = self._resolve_items(input_data)
        total = len(items)
        if total > self.cap:
            items = items[: self.cap]
            if self.event_bus:
                self.event_bus.send({
                    "type": "node_warning",
                    "node_id": self.node_id,
                    "message": f"Fan-out capped at {self.cap} (had {total})",
                })

        if self.event_bus:
            self.event_bus.send({
                "type": "node_started",
                "node_type": "fanout",
                "node_id": self.node_id,
                "count": len(items),
            })

        sem = asyncio.Semaphore(self.cap)

        async def _run_child(index: int, item: Any) -> Any:
            child = TerminalNode(
                manager=self.manager,
                argv_template=self.argv_template,
                cols=self.cols,
                rows=self.rows,
                event_bus=self.event_bus,
                node_id=f"{self.node_id}/{index}",
                cwd=self.cwd,
                parent_id=self.node_id,
                outputs=self.outputs,
            )
            async with sem:
                try:
                    return await child.run(item)
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # best-effort: mark, don't abort siblings
                    return {"output": str(e).encode(), "exit_code": None, "error": str(e)}

        results = await asyncio.gather(*(_run_child(i, it) for i, it in enumerate(items)))

        if self.event_bus:
            self.event_bus.send({"type": "node_finished", "node_type": "fanout", "node_id": self.node_id})
        return results


_JSON_ARRAY_RE = re.compile(r"\[.*\]", re.DOTALL)


def parse_list(text: str) -> Optional[list]:
    """Best-effort: pull a JSON array out of ``text``. Returns None if none found."""
    text = text.strip()
    try:
        val = json.loads(text)
        if isinstance(val, list):
            return val
    except (ValueError, TypeError):
        pass
    match = _JSON_ARRAY_RE.search(text)
    if match:
        try:
            val = json.loads(match.group(0))
            if isinstance(val, list):
                return val
        except (ValueError, TypeError):
            pass
    return None


def _extract_json(text: str):
    """Scan for the first position that yields a valid JSON value (object or
    array) and return it, ignoring any trailing content. Returns None if none
    parses — robust to PTY noise around a CLI's JSON envelope."""
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch in "{[":
            try:
                value, _ = decoder.raw_decode(text[i:])
                return value
            except ValueError:
                continue
    return None


class Structurer:
    """Port: turn unstructured text into a list of items. Returns None when it
    cannot produce a list (the caller then degrades gracefully)."""

    async def structure(self, text: str) -> Optional[List[str]]:
        raise NotImplementedError


class TerminalStructurer(Structurer):
    """Structurer adapter backed by a headless ``claude`` terminal.

    Runs as a real PTY so it renders as a live card inside the dynamic-batch
    box (the "Claude LLM" node in the design). Parsing is best-effort; a future
    ``ApiStructurer`` can swap in schema-constrained structured outputs behind
    the same port.
    """

    PROMPT = (
        "Convert the following text into a JSON array of strings, one element "
        "per distinct item. Output ONLY the JSON array, no prose.\n\nText:\n"
    )

    def __init__(
        self,
        manager: SessionManager,
        model: str = "prism-a",
        event_bus: Subscriber = None,
        node_id: Any = None,
        parent_id: Any = None,
        cwd: str = None,
    ):
        self.manager = manager
        self.model = model
        self.event_bus = event_bus
        self.node_id = node_id
        self.parent_id = parent_id
        self.cwd = cwd

    async def structure(self, text: str) -> Optional[List[str]]:
        argv = ["claude", "-p", "--output-format", "json", self.PROMPT + text]
        node = TerminalNode(
            manager=self.manager,
            argv_template=argv,
            event_bus=self.event_bus,
            node_id=self.node_id,
            parent_id=self.parent_id,
            cwd=self.cwd,
            internal=True,  # hidden plumbing — no UI card
        )
        result = await node.run(None)
        decoded = _strip_ansi(bytes(result.get("output", b""))).decode("utf-8", "replace")
        # `claude --output-format json` prints a JSON envelope; pull the inner
        # `result` (the model's reply), then extract the array from it.
        env = _extract_json(decoded)
        if isinstance(env, dict) and "result" in env:
            inner = env["result"]
            if not isinstance(inner, str):
                inner = json.dumps(inner)
        else:
            inner = decoded
        parsed = parse_list(inner)
        return [str(x) for x in parsed] if parsed is not None else None


class DynamicBatchNode(Node):
    """Coerces unstructured input into a list (via a Structurer), then fans out
    one terminal per item. Skips the structurer entirely when the input is
    already a list or already valid JSON."""

    def __init__(
        self,
        fanout: FanOutNode,
        structurer: Structurer,
        event_bus: Subscriber = None,
        node_id: Any = None,
    ):
        self.fanout = fanout
        self.structurer = structurer
        self.event_bus = event_bus
        self.node_id = node_id

    async def _coerce(self, input_data: Any) -> List[Any]:
        if isinstance(input_data, list):
            return input_data
        text = render_input(input_data)
        direct = parse_list(text)
        if direct is not None:  # already structured upstream — skip the LLM
            return [str(x) for x in direct]
        items = await self.structurer.structure(text)
        if not items:  # parse failed / empty — degrade to a single item
            if self.event_bus:
                self.event_bus.send({
                    "type": "node_warning",
                    "node_id": self.node_id,
                    "message": "Could not structure input; running as a single item",
                })
            return [text]
        return items

    async def run(self, input_data: Any) -> List[Any]:
        items = await self._coerce(input_data)
        return await self.fanout.run(items)


class PipelineEngine:
    """Entry point for running a composed pipeline and watching its progress."""

    def __init__(self, root_node: Node, sub: Subscriber, outputs: dict = None):
        self.root_node = root_node
        self.sub = sub
        # Coordinator-owned map of every leaf node's output, keyed by node_id.
        self.outputs = outputs if outputs is not None else {}

    async def execute(self, initial_input: Any = None):
        self.sub.send({"type": "pipeline_started"})
        try:
            result = await self.root_node.run(initial_input)
            self.sub.send({
                "type": "pipeline_finished",
                "result": result,
                "outputs": self.outputs,
            })
            return result
        except asyncio.CancelledError:
            self.sub.send({"type": "pipeline_error", "message": "Pipeline cancelled"})
            raise
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
    outputs: dict = None,
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
            outputs=outputs,
        )
    elif ntype == "fanout":
        raw_cwd = spec.get("cwd")
        resolved = _resolve_cwd(raw_cwd, _global_cwd) if raw_cwd else _global_cwd
        return FanOutNode(
            manager=manager,
            argv_template=spec["argv"],
            cols=spec.get("cols", 80),
            rows=spec.get("rows", 24),
            event_bus=event_bus,
            node_id=spec.get("id"),
            cwd=resolved,
            cap=spec.get("cap", DEFAULT_FANOUT_CAP),
            count=spec.get("count"),
            outputs=outputs,
        )
    elif ntype == "dynamic_batch":
        raw_cwd = spec.get("cwd")
        resolved = _resolve_cwd(raw_cwd, _global_cwd) if raw_cwd else _global_cwd
        node_id = spec.get("id")
        fanout = FanOutNode(
            manager=manager,
            argv_template=spec["argv"],
            cols=spec.get("cols", 80),
            rows=spec.get("rows", 24),
            event_bus=event_bus,
            node_id=node_id,
            cwd=resolved,
            cap=spec.get("cap", DEFAULT_FANOUT_CAP),
            outputs=outputs,
        )
        structurer = TerminalStructurer(
            manager=manager,
            model=spec.get("model", "prism-a"),
            event_bus=event_bus,
            node_id=f"{node_id}/structurer",
            parent_id=node_id,
            cwd=resolved,
        )
        return DynamicBatchNode(fanout, structurer, event_bus=event_bus, node_id=node_id)
    elif ntype == "batch":
        nodes = [build_node_tree(n, manager, event_bus, _global_cwd, outputs) for n in spec["nodes"]]
        return BatchNode(nodes, concurrency=spec.get("concurrency"), event_bus=event_bus)
    elif ntype == "sequence":
        nodes = [build_node_tree(n, manager, event_bus, _global_cwd, outputs) for n in spec["nodes"]]
        return SequenceNode(nodes, event_bus=event_bus)
    else:
        raise ValueError(f"Unknown node type: {ntype}")
