import asyncio
import json
import os
import re
from typing import Any, List, Optional, Callable
from .manager import SessionManager
from .session import Subscriber
from agents.acp import AcpPool, Transcript, AcpSession

# Matches ANSI/VT escape sequences so PTY output can be cleaned before it is
# piped into a downstream node as {{input}} or rendered as a final result.
# Covers CSI (ESC[...), OSC (ESC]...BEL/ST), and the nF/Fp/Fe single-final
# escapes (charset designation like ESC(B, keypad modes like ESC=, etc.).
# The OSC terminator is optional: a TUI tearing down on exit (e.g. claude under
# tmux) can emit ESC]0; immediately followed by the next ESC with no BEL/ST, so
# we also stop at the next ESC (the [^\x07\x1b]* already excludes it).
_ANSI_RE = re.compile(
    rb"\x1b\[[0-?]*[ -/]*[@-~]"             # CSI  (incl. private params <=>?)
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?"  # OSC  (BEL/ST terminator optional)
    rb"|\x1b[ -/]*[0-~]"                     # nF / charset / keypad / Fe escapes
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


_TEMPLATE_RE = re.compile(r"\{\{(\w+)\}\}")


def _apply_template(text: str, variables: dict) -> str:
    """Substitute {{name}} placeholders from ``variables``; unknown names are
    left intact. Used for {{input}} and, inside an ``itr`` body, the per-pass
    loop vars {{goal}} and {{iteration}}."""
    return _TEMPLATE_RE.sub(lambda m: variables.get(m.group(1), m.group(0)), text)


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
        loop_vars: dict = None,
    ):
        self.manager = manager
        self.argv_template = argv_template
        self.cols = cols
        self.rows = rows
        self.event_bus = event_bus
        # Mutable map of extra {{...}} vars, shared with an enclosing IterationNode
        # ({{goal}}, {{iteration}}); read at run() time so per-pass updates apply.
        self.loop_vars = loop_vars
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
        # Templating: replace {{input}} with the decoded upstream output, plus
        # any loop vars ({{goal}}, {{iteration}}) when inside an ``itr`` body.
        variables = {"input": render_input(input_data)}
        if self.loop_vars:
            variables.update(self.loop_vars)
        argv = [_apply_template(arg, variables) for arg in self.argv_template]

        sub = CollectorSubscriber()
        # capture=True: this node's stdout is piped downstream, so the backend
        # sets up a clean side-tap. Under tmux the PTY stream is a rendered
        # screen (good for the live card + native attach); read_capture() below
        # returns the clean stdout for piping. Under the bare backend the PTY
        # stream is already clean and read_capture() returns None.
        # The run's backend choice lives on the event bus (PipelineRun); pass it
        # per-call so concurrent runs can use different backends.
        sess = self.manager.create(cols=self.cols, rows=self.rows, argv=argv, cwd=self.cwd,
                                   capture=True, backend=getattr(self.event_bus, "node_backend", None))
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
            self.manager.end_capture(sess)
            raise

        # Prefer the backend's clean side-tap for the piped output; None means
        # the PTY stream we already collected is clean (bare backend).
        clean = self.manager.read_capture(sess)
        if clean is not None:
            output = clean
        self.manager.end_capture(sess)

        # Strip terminal control sequences at the source so the stored result is
        # plain text for BOTH the piped {{input}} and the per-node output the UI
        # renders. (The live card shows the raw rendered stream separately.)
        output = _strip_ansi(bytes(output)).replace(b"\r\n", b"\n").replace(b"\r", b"")

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
        loop_vars: dict = None,
    ):
        self.manager = manager
        self.argv_template = argv_template
        self.cols = cols
        self.rows = rows
        self.event_bus = event_bus
        self.node_id = node_id
        self.cwd = cwd
        self.outputs = outputs
        self.loop_vars = loop_vars
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
                loop_vars=self.loop_vars,
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


class Judge:
    """Port: decide whether an iteration loop is complete from the latest output.
    Returns True to stop the loop. Mirrors Structurer — a future ApiJudge can swap
    schema-constrained structured output in behind the same interface."""

    async def is_complete(self, last_output: str, ctx: dict = None) -> bool:
        raise NotImplementedError


_COMPLETE_RE = re.compile(r"\bCOMPLETE\b", re.IGNORECASE)
_CONTINUE_RE = re.compile(r"\bCONTINUE\b", re.IGNORECASE)


def _verdict_complete(text: str) -> bool:
    """Read a judge reply as a COMPLETE/CONTINUE verdict, biased to CONTINUE: an
    explicit CONTINUE wins over a stray 'complete' ('not complete, continue'), and
    anything unreadable (empty/parse-fail) is CONTINUE. '\\bCOMPLETE\\b' won't match
    inside 'incomplete'."""
    if _CONTINUE_RE.search(text):
        return False
    return bool(_COMPLETE_RE.search(text))


class TerminalJudge(Judge):
    """Judge backed by a headless ``claude`` run, hidden (``internal=True``) so it
    renders no UI card — the "dumb agent" that reads the last node's output and
    returns COMPLETE / CONTINUE.

    With a plain-language ``criterion`` it judges against that; with none it
    self-assesses whether the output signals it is finished. Parsing is lenient
    and biased toward CONTINUE: an explicit CONTINUE wins, and anything we can't
    read as COMPLETE keeps the loop going (``max_iterations`` is the backstop)."""

    def __init__(self, manager: SessionManager, criterion: str = None, model: str = None,
                 event_bus: Subscriber = None, node_id: Any = None, parent_id: Any = None,
                 cwd: str = None):
        self.manager = manager
        self.criterion = (criterion or "").strip() or None
        self.model = model
        self.event_bus = event_bus
        self.node_id = node_id
        self.parent_id = parent_id
        self.cwd = cwd

    def _build_prompt(self, last_output: str, ctx: dict) -> str:
        ctx = ctx or {}
        head = []
        if ctx.get("goal"):
            head.append(f"GOAL: {ctx['goal']}")
        if ctx.get("iteration"):
            head.append(f"This is pass {ctx['iteration']}.")
        preamble = ("\n".join(head) + "\n\n") if head else ""
        if self.criterion:
            condition = (
                f"Decide whether this CONDITION is met by the OUTPUT.\n\n"
                f"CONDITION: {self.criterion}\n\n"
            )
        else:
            condition = (
                "Decide whether the OUTPUT indicates the work is COMPLETE — i.e. it "
                "signals it is finished and satisfactory with nothing left to fix "
                "(e.g. expresses satisfaction, calls it final/done, raises no "
                "remaining issues).\n\n"
            )
        return (
            "You are a strict completion judge for an iterative loop.\n"
            + preamble + condition
            + f"OUTPUT:\n{last_output}\n\n"
            "Reply with exactly one word: COMPLETE if so, otherwise CONTINUE."
        )

    async def is_complete(self, last_output: str, ctx: dict = None) -> bool:
        argv = ["claude", "-p", "--output-format", "json"]
        if self.model:
            argv += ["--model", self.model]
        argv.append(self._build_prompt(last_output, ctx))
        node = TerminalNode(
            manager=self.manager, argv_template=argv, event_bus=self.event_bus,
            node_id=self.node_id, parent_id=self.parent_id, cwd=self.cwd,
            internal=True,  # hidden plumbing — no UI card
        )
        result = await node.run(None)
        decoded = _strip_ansi(bytes(result.get("output", b""))).decode("utf-8", "replace")
        env = _extract_json(decoded)
        if isinstance(env, dict) and "result" in env:
            inner = env["result"]
            text = inner if isinstance(inner, str) else json.dumps(inner)
        else:
            text = decoded
        return _verdict_complete(text)


DEFAULT_MAX_ITERATIONS = 5


class IterationNode(Node):
    """Loop combinator: runs ``body`` (a SequenceNode) repeatedly, feeding each
    pass's output back as the next pass's input, until ``judge`` says the work is
    complete or ``max_iterations`` is reached.

    Per-pass template vars ({{goal}} = the input that entered the loop; {{iteration}}
    = 1-based pass number) are published into the shared ``loop_vars`` dict that the
    body's nodes read, in addition to the {{input}} carry. The loop's result is the
    final pass's output, so a node placed after the ``itr`` receives the converged
    value."""

    def __init__(self, body: Node, judge: Judge, max_iterations: int = DEFAULT_MAX_ITERATIONS,
                 loop_vars: dict = None, event_bus: Subscriber = None, node_id: Any = None,
                 outputs: dict = None):
        self.body = body
        self.judge = judge
        self.max_iterations = max_iterations if max_iterations and max_iterations > 0 else DEFAULT_MAX_ITERATIONS
        # Shared with the body's nodes; updated before each pass.
        self.loop_vars = loop_vars if loop_vars is not None else {}
        self.event_bus = event_bus
        self.node_id = node_id
        self.outputs = outputs

    def _emit(self, event: dict) -> None:
        if self.event_bus:
            self.event_bus.send(event)

    async def run(self, input_data: Any) -> Any:
        goal = render_input(input_data)
        current = input_data
        self._emit({
            "type": "node_started", "node_type": "iteration",
            "node_id": self.node_id, "max_iterations": self.max_iterations,
        })
        for i in range(1, self.max_iterations + 1):
            self.loop_vars["goal"] = goal
            self.loop_vars["iteration"] = str(i)
            self._emit({
                "type": "iteration_started", "node_id": self.node_id,
                "iteration": i, "max_iterations": self.max_iterations,
            })
            current = await self.body.run(current)
            complete = await self.judge.is_complete(
                render_input(current), {"goal": goal, "iteration": i})
            self._emit({
                "type": "iteration_finished", "node_id": self.node_id,
                "iteration": i, "complete": complete,
            })
            if complete:
                break
        if self.outputs is not None and self.node_id is not None:
            self.outputs[self.node_id] = (
                current if isinstance(current, dict)
                else {"output": render_input(current).encode(), "exit_code": 0})
        self._emit({
            "type": "node_finished", "node_type": "iteration", "node_id": self.node_id,
        })
        return current


class AgentBackend:
    """Port: translate a prompt + config into a runnable command (argv).

    Mirrors Structurer — lets another agent CLI (e.g. auggie) or a future
    SDK/steerable/delegating backend slot in without touching the node tree or
    the DSL. Only ClaudeAgentBackend exists for now.
    """

    def build_argv(self, prompt: str, config: dict) -> List[str]:
        raise NotImplementedError


class ClaudeAgentBackend(AgentBackend):
    """Runs Claude headless via the CLI (`claude -p`). Translates our config
    (e.g. `model`) into Claude's actual flags."""

    def build_argv(self, prompt: str, config: dict) -> List[str]:
        argv = ["claude", "-p"]
        model = (config or {}).get("model")
        if model:
            argv += ["--model", model]
        argv.append(prompt)
        return argv


class AgentNode(Node):
    """A single agent turn. Runs the backend's CLI through a PTY so it renders
    as a terminal card; the AgentBackend port keeps room for other backends and
    a later steerable/delegating implementation. ``delegate`` is carried as
    config but not yet wired to visible sub-agent spawning.
    """

    def __init__(
        self,
        manager: SessionManager,
        backend: AgentBackend,
        prompt: str,
        config: dict = None,
        cols: int = 80,
        rows: int = 24,
        event_bus: Subscriber = None,
        node_id: Any = None,
        cwd: str = None,
        outputs: dict = None,
        parent_id: Any = None,
    ):
        self.manager = manager
        self.backend = backend
        self.prompt = prompt
        self.config = config or {}
        self.cols = cols
        self.rows = rows
        self.event_bus = event_bus
        self.node_id = node_id
        self.cwd = cwd
        self.outputs = outputs
        self.parent_id = parent_id

    async def run(self, input_data: Any) -> Any:
        # build_argv leaves {{input}} in the prompt; the inner TerminalNode does
        # the interpolation (and the node_started/finished + outputs recording)
        # under this node's id, so the agent appears like any terminal node.
        argv = self.backend.build_argv(self.prompt, self.config)
        node = TerminalNode(
            manager=self.manager,
            argv_template=argv,
            cols=self.cols,
            rows=self.rows,
            event_bus=self.event_bus,
            node_id=self.node_id,
            cwd=self.cwd,
            outputs=self.outputs,
            parent_id=self.parent_id,
        )
        return await node.run(input_data)


# The CLI accepts model aliases ("opus"); the SDK Messages API needs full ids.
_MODEL_ALIASES = {
    "opus": "claude-opus-4-8",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
}


def _resolve_model(m: Optional[str]) -> str:
    if not m:
        return "claude-opus-4-8"
    return _MODEL_ALIASES.get(m, m)  # pass full ids through unchanged


DELEGATE_TOOL = {
    "name": "delegate",
    "description": (
        "Delegate a self-contained sub-task to a sub-agent. The sub-agent runs "
        "Claude with full local tools in the working directory and returns its "
        "result. Use this to do real work — you (the coordinator) cannot read "
        "files or run commands yourself, only delegate."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Short title for the sub-task / sub-agent."},
            "task": {"type": "string", "description": "Full, self-contained instructions for the sub-agent."},
        },
        "required": ["name", "task"],
    },
}

ASK_USER_TOOL = {
    "name": "ask_user",
    "description": (
        "Ask the human a question and wait for their typed reply. Use this only "
        "when you need information or a decision that only the user can provide "
        "(e.g. which ticket to read). Returns the user's answer."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"question": {"type": "string", "description": "The question for the user."}},
        "required": ["question"],
    },
}

DEFAULT_COORDINATOR_SYSTEM = (
    "You are a coordinator agent. You have two tools: `delegate` spawns a "
    "sub-agent to do real work and returns its result; `ask_user` asks the human "
    "a question and waits for their reply. Break the request into sub-tasks, "
    "delegate them, ask the user when you genuinely need their input, and "
    "synthesize a final answer from the results. Keep your own messages brief."
)


class CoordinatorAgentNode(Node):
    """An agent that runs the Anthropic Messages API in a loop with a single
    ``delegate`` tool. Each delegate call spawns a child :class:`AgentNode`
    (CLI) under this node, runs it, and feeds its result back as the tool
    result. The coordinator's transcript renders in a virtual session (a
    terminal card); the children render nested beneath it via ``parent_id``.
    """

    def __init__(
        self,
        manager: SessionManager,
        prompt: str,
        system: str = None,
        model: str = None,
        config: dict = None,
        cols: int = 80,
        rows: int = 24,
        event_bus: Subscriber = None,
        node_id: Any = None,
        cwd: str = None,
        outputs: dict = None,
        max_delegations: int = 4,
        max_turns: int = 12,
    ):
        self.manager = manager
        self.prompt = prompt
        self.system = system or DEFAULT_COORDINATOR_SYSTEM
        self.model = _resolve_model(model)
        self.config = config or {}
        self.cols = cols
        self.rows = rows
        self.event_bus = event_bus
        self.node_id = node_id
        self.cwd = cwd
        self.outputs = outputs
        self.max_delegations = max_delegations
        self.max_turns = max_turns

    def _narrate(self, vsess, text: str) -> None:
        # Terminal cards expect CRLF line endings.
        self.manager.feed(vsess, text.replace("\n", "\r\n").encode())

    def _register_inbox(self, inbox) -> Optional[dict]:
        """Register this coordinator's inbound message queue on the subscriber,
        keyed by node_id, so the server can route `node_input` (user steering)
        to the right running coordinator. Returns the registry (for cleanup)."""
        if self.event_bus is None or self.node_id is None:
            return None
        registry = getattr(self.event_bus, "agent_inboxes", None)
        if registry is None:
            registry = {}
            try:
                self.event_bus.agent_inboxes = registry
            except Exception:
                return None
        registry[self.node_id] = inbox
        return registry

    def _drain(self, inbox) -> List[str]:
        out = []
        while not inbox.empty():
            out.append(inbox.get_nowait())
        return out

    async def run(self, input_data: Any) -> Any:
        from anthropic import AsyncAnthropic  # lazy: only coordinator nodes need it

        vsess = self.manager.create_virtual(self.cols, self.rows)
        if self.event_bus:
            self.event_bus.send({
                "type": "node_started", "node_type": "terminal",
                "id": vsess.id, "node_id": self.node_id, "parent_id": None,
                "internal": False, "argv": ["coordinator"],
            })

        inbox = asyncio.Queue()
        registry = self._register_inbox(inbox)

        kickoff = (
            self.prompt.replace("{{input}}", render_input(input_data))
            if self.prompt else (render_input(input_data) or "go")
        )
        self._narrate(vsess, f"coordinator · {self.model}\n> {kickoff}\n\n")

        client = AsyncAnthropic()
        messages = [{"role": "user", "content": kickoff}]
        final_text = ""
        delegations = 0
        try:
            for _turn in range(self.max_turns):
                resp = await client.messages.create(
                    model=self.model,
                    max_tokens=4096,
                    system=self.system,
                    tools=[DELEGATE_TOOL, ASK_USER_TOOL],
                    messages=messages,
                )
                for block in resp.content:
                    if block.type == "text" and block.text.strip():
                        final_text = block.text
                        self._narrate(vsess, block.text + "\n")
                if resp.stop_reason != "tool_use":
                    # Autonomous end — unless the user has queued steering input.
                    pending = self._drain(inbox)
                    if pending:
                        # (no narration: terminal already echoed the typed input)
                        messages.append({"role": "assistant", "content": resp.content})
                        messages.append({"role": "user", "content": "\n".join(pending)})
                        continue
                    break
                messages.append({"role": "assistant", "content": resp.content})
                tool_results = []
                for block in resp.content:
                    if block.type != "tool_use":
                        continue
                    if block.name == "delegate":
                        name = block.input.get("name", "sub-agent")
                        task = block.input.get("task", "")
                        if delegations >= self.max_delegations:
                            tool_results.append({
                                "type": "tool_result", "tool_use_id": block.id,
                                "content": "Delegation limit reached.", "is_error": True,
                            })
                            continue
                        self._narrate(vsess, f"\n→ delegating [{name}]…\n")
                        child = AgentNode(
                            manager=self.manager,
                            backend=ClaudeAgentBackend(),
                            prompt=task,
                            config={"model": self.config.get("model")},
                            cols=self.cols, rows=self.rows,
                            event_bus=self.event_bus,
                            node_id=f"{self.node_id}/{delegations}",
                            cwd=self.cwd,
                            outputs=self.outputs,
                            parent_id=self.node_id,
                        )
                        delegations += 1
                        child_result = await child.run(None)
                        child_text = render_input(child_result)
                        tool_results.append({
                            "type": "tool_result", "tool_use_id": block.id,
                            "content": child_text or "(no output)",
                        })
                        self._narrate(vsess, f"← [{name}] returned ({len(child_text)} chars)\n")
                    elif block.name == "ask_user":
                        question = block.input.get("question", "")
                        self._narrate(vsess, f"\n? {question}\n")
                        if self.event_bus:
                            self.event_bus.send({
                                "type": "needs_input", "id": vsess.id,
                                "node_id": self.node_id, "parent_id": None,
                                "last_output": question.encode(),
                            })
                        answer = await inbox.get()  # block until the user replies
                        if self.event_bus:
                            self.event_bus.send({
                                "type": "node_status", "node_id": self.node_id, "status": "running",
                            })
                        # (no narration: the terminal already locally-echoed the
                        # user's typed reply)
                        tool_results.append({
                            "type": "tool_result", "tool_use_id": block.id,
                            "content": answer or "(no answer)",
                        })
                messages.append({"role": "user", "content": tool_results})
        finally:
            try:
                await client.close()  # release the httpx connection pool
            except Exception:
                pass
            if registry is not None:
                registry.pop(self.node_id, None)
            self.manager.finish_virtual(vsess)

        result = {"output": final_text.encode(), "exit_code": 0}
        if self.outputs is not None and self.node_id is not None:
            self.outputs[self.node_id] = result
        if self.event_bus:
            self.event_bus.send({
                "type": "node_finished", "id": vsess.id, "node_id": self.node_id,
                "parent_id": None, "exit_code": 0, "output": final_text.encode(),
            })
        return result


class AcpNode(Node):
    """A coding-agent node driven over ACP (Agent Client Protocol). It spawns (or
    reuses) an ACP agent subprocess from the run's :class:`AcpPool`, opens a
    session, sends the prompt, and folds the agent's ``session/update`` stream
    into a :class:`Transcript`.

    Phase 1 renders that transcript as text in a virtual-session terminal card
    (reusing the coordinator's card machinery) and auto-approves permission
    requests; the structured card + approval UI arrive in Phase 2. The agent
    reaches the filesystem only by calling ``fs/*`` back on us, confined to this
    node's cwd — it has no direct access.
    """

    def __init__(
        self,
        manager: SessionManager,
        agent: str,
        prompt: str,
        cols: int = 80,
        rows: int = 24,
        event_bus: Subscriber = None,
        node_id: Any = None,
        cwd: str = None,
        outputs: dict = None,
        mcps: list = None,
        permission: str = "auto",
        parent_id: Any = None,
    ):
        self.manager = manager
        self.agent = agent or "stub"
        self.prompt = prompt if prompt is not None else "{{input}}"
        self.cols = cols
        self.rows = rows
        self.event_bus = event_bus
        self.node_id = node_id
        self.cwd = cwd
        self.outputs = outputs
        self.mcps = mcps or []
        self.permission = permission or "auto"
        self.parent_id = parent_id

    def _narrate(self, vsess, text: str) -> None:
        self.manager.feed(vsess, text.replace("\n", "\r\n").encode())

    def _pool(self) -> AcpPool:
        """Get-or-create the run's AcpPool (holds the agent subprocesses) so every
        ACP node in a run shares warm agents and one teardown kills them all."""
        pool = getattr(self.event_bus, "acp", None)
        if pool is None:
            pool = AcpPool()
            try:
                self.event_bus.acp = pool
            except Exception:
                pass
        return pool

    def _register_inbox(self, inbox) -> Optional[dict]:
        """Register this node's input queue on the run (keyed by node_id) so the
        server routes `node_input` (a conversational reply) / `acp_finish` to it."""
        if self.event_bus is None or self.node_id is None:
            return None
        registry = getattr(self.event_bus, "agent_inboxes", None)
        if registry is None:
            registry = {}
            try:
                self.event_bus.agent_inboxes = registry
            except Exception:
                return None
        registry[self.node_id] = inbox
        return registry

    async def run(self, input_data: Any) -> Any:
        vsess = self.manager.create_virtual(self.cols, self.rows)
        if self.event_bus:
            self.event_bus.send({
                "type": "node_started", "node_type": "terminal",
                "id": vsess.id, "node_id": self.node_id, "parent_id": self.parent_id,
                "internal": False, "argv": ["acp", self.agent],
            })

        prompt = (_apply_template(self.prompt, {"input": render_input(input_data)})
                  if self.prompt else render_input(input_data))
        self._narrate(vsess, f"acp · {self.agent}\n")

        inbox = asyncio.Queue()
        inbox_registry = self._register_inbox(inbox)
        session = None
        stop_reason = None
        failed = False
        try:
            client = await self._pool().get(self.agent, self.cwd)
            session = AcpSession(
                client, self.cwd, key=self.node_id, key_field="node_id",
                emit=(self.event_bus.send if self.event_bus else None),
                perms=getattr(self.event_bus, "acp_perms", None),
                permission=self.permission, agent=self.agent,
                on_narrate=lambda text: self._narrate(vsess, text))
            await session.open(mcps=[])
            # Register the session so the server routes set_mode/set_model to it.
            sessions = getattr(self.event_bus, "acp_sessions", None)
            if sessions is not None:
                sessions[self.node_id] = (client, session.session_id)
            # Conversational loop: ACP has no "awaiting input" signal — every turn
            # ends `end_turn` and hands control back — so after each turn we surface
            # a reply box and continue on the SAME session until the user finishes
            # (inbox receives None) or the agent stops abnormally.
            while True:
                session.record_user(prompt)
                stop_reason = await session.prompt(prompt)
                if stop_reason not in (None, "end_turn"):
                    break  # refusal / cancelled / limit — end the conversation
                if self.event_bus:
                    self.event_bus.send({
                        "type": "needs_input", "id": vsess.id, "node_id": self.node_id,
                        "parent_id": self.parent_id, "last_output": b"",
                    })
                reply = await inbox.get()
                if self.event_bus:
                    self.event_bus.send({
                        "type": "node_status", "node_id": self.node_id, "status": "running"})
                if reply is None:  # user pressed Finish
                    break
                prompt = reply
        except Exception as exc:  # noqa: BLE001 — surface agent/spawn failures in the card
            failed = True
            if session is not None:
                session.record_error(str(exc))
            else:
                self._narrate(vsess, f"\n[acp error] {exc}\n")
        finally:
            if inbox_registry is not None:
                inbox_registry.pop(self.node_id, None)
            sessions = getattr(self.event_bus, "acp_sessions", None)
            if sessions is not None:
                sessions.pop(self.node_id, None)
            if session is not None:
                await session.close()
            self.manager.finish_virtual(vsess)

        transcript = session.transcript if session is not None \
            else Transcript(self.node_id, None, self.agent, self.cwd)
        transcript.finalize(stop_reason)
        text = transcript.assistant_text()
        exit_code = 0 if (not failed and stop_reason in (None, "end_turn")) else 1
        result = {"output": text.encode(), "exit_code": exit_code, "transcript": transcript.to_json()}
        if self.outputs is not None and self.node_id is not None:
            self.outputs[self.node_id] = result
        if self.event_bus:
            self.event_bus.send({
                "type": "node_finished", "id": vsess.id, "node_id": self.node_id,
                "parent_id": self.parent_id, "exit_code": exit_code, "output": text.encode(),
            })
            # Authoritative final transcript (also a snapshot for late-join replay).
            self.event_bus.send({
                "type": "acp_finished", "node_id": self.node_id,
                "stop_reason": stop_reason, "transcript": transcript.to_json(),
            })
        return result


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
            # User cancelled (or the workspace is closing) — a deliberate stop, not
            # an error. Report it as a distinct, neutral state.
            self.sub.send({"type": "pipeline_cancelled", "message": "Pipeline cancelled"})
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
    loop_vars: dict = None,
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
            loop_vars=loop_vars,
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
            loop_vars=loop_vars,
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
            loop_vars=loop_vars,
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
    elif ntype == "agent":
        raw_cwd = spec.get("cwd")
        resolved = _resolve_cwd(raw_cwd, _global_cwd) if raw_cwd else _global_cwd
        # An agent node is a coordinator: it runs the SDK loop with a `delegate`
        # tool and spawns child CLI AgentNodes (claude -p) for the real work.
        return CoordinatorAgentNode(
            manager=manager,
            prompt=spec.get("prompt", ""),
            system=spec.get("system"),
            model=spec.get("model"),
            config={"model": spec.get("model"), "mcps": spec.get("mcps", [])},
            cols=spec.get("cols", 80),
            rows=spec.get("rows", 24),
            event_bus=event_bus,
            node_id=spec.get("id"),
            cwd=resolved,
            outputs=outputs,
        )
    elif ntype == "acp":
        raw_cwd = spec.get("cwd")
        resolved = _resolve_cwd(raw_cwd, _global_cwd) if raw_cwd else _global_cwd
        # A coding-agent node driven over ACP: spawns/reuses an agent subprocess
        # (from the run's AcpPool) and streams its session/update transcript.
        return AcpNode(
            manager=manager,
            agent=spec.get("agent", "stub"),
            prompt=spec.get("prompt", "{{input}}"),
            cols=spec.get("cols", 80),
            rows=spec.get("rows", 24),
            event_bus=event_bus,
            node_id=spec.get("id"),
            cwd=resolved,
            outputs=outputs,
            mcps=spec.get("mcps", []),
            permission=spec.get("permission", "auto"),
        )
    elif ntype == "batch":
        nodes = [build_node_tree(n, manager, event_bus, _global_cwd, outputs, loop_vars) for n in spec["nodes"]]
        return BatchNode(nodes, concurrency=spec.get("concurrency"), event_bus=event_bus)
    elif ntype == "sequence":
        nodes = [build_node_tree(n, manager, event_bus, _global_cwd, outputs, loop_vars) for n in spec["nodes"]]
        return SequenceNode(nodes, event_bus=event_bus)
    elif ntype == "iteration":
        raw_cwd = spec.get("cwd")
        resolved = _resolve_cwd(raw_cwd, _global_cwd) if raw_cwd else _global_cwd
        node_id = spec.get("id")
        # A fresh, mutable vars map shared between the IterationNode (writer) and
        # the body's nodes (readers), so {{goal}}/{{iteration}} update per pass.
        body_vars = {}
        body_spec = spec.get("body") or {"type": "sequence", "nodes": spec.get("nodes", [])}
        body = build_node_tree(body_spec, manager, event_bus, _global_cwd, outputs, loop_vars=body_vars)
        judge = TerminalJudge(
            manager=manager,
            criterion=spec.get("until"),
            model=spec.get("model"),
            event_bus=event_bus,
            node_id=f"{node_id}/judge",
            parent_id=node_id,
            cwd=resolved,
        )
        return IterationNode(
            body=body,
            judge=judge,
            max_iterations=spec.get("max_iterations", DEFAULT_MAX_ITERATIONS),
            loop_vars=body_vars,
            event_bus=event_bus,
            node_id=node_id,
            outputs=outputs,
        )
    else:
        raise ValueError(f"Unknown node type: {ntype}")
