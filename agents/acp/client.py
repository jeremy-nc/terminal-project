"""AcpClient: spawn an ACP agent as a child process and speak JSON-RPC 2.0 over
its stdio pipes (newline-delimited JSON — one object per line). We are the parent
process, so we own the child's lifecycle. One client hosts many sessions; the
per-session notification/request traffic is dispatched by ``sessionId`` via
``route``."""
import asyncio
import json
import os
import signal
from itertools import count

# Parent-session markers stripped from the agent's env: a Claude Code agent (or
# any nested coding agent) refuses to launch inside another session ("cannot be
# launched inside another Claude Code session"). We spawn it as a managed child,
# so it must not see the host session's markers.
_STRIP_ENV = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT")


class AcpClient:
    def __init__(self, argv, cwd, env=None):
        self._argv = list(argv)
        self._cwd = cwd
        strip = set(_STRIP_ENV)
        # Prefer the logged-in subscription over a stray console API key: when a
        # CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is present, drop
        # ANTHROPIC_API_KEY so the agent authenticates as that subscription and
        # can't be hijacked onto a different account's credits.
        if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
            strip.add("ANTHROPIC_API_KEY")
        base = {k: v for k, v in os.environ.items() if k not in strip}
        self._env = {**base, **(env or {})}
        self._proc = None
        self._ids = count(1)
        self._pending = {}          # request id -> Future(result)
        self._routes = {}           # sessionId -> {"on_update", "on_request"}
        self._reader = None
        self._stderr = None

    # ── lifecycle ────────────────────────────────────────────────────────────
    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            *self._argv,
            cwd=self._cwd,
            env=self._env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,     # own process group → close() kills the whole tree
            limit=2 ** 22,              # 4 MB line buffer for large tool outputs
        )
        self._reader = asyncio.create_task(self._read_loop())
        self._stderr = asyncio.create_task(self._drain_stderr())

    async def close(self) -> None:
        for task in (self._reader, self._stderr):
            if task is not None:
                task.cancel()
        proc = self._proc
        if proc is not None and proc.returncode is None:
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3)
                except asyncio.TimeoutError:
                    os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass
        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        self._pending.clear()
        self._routes.clear()

    # ── session routing ──────────────────────────────────────────────────────
    def route(self, session_id, on_update, on_request) -> None:
        """Dispatch this session's notifications/requests to these callbacks:
        ``on_update(params)`` is sync; ``on_request(method, params)`` is awaited."""
        self._routes[session_id] = {"on_update": on_update, "on_request": on_request}

    def unroute(self, session_id) -> None:
        self._routes.pop(session_id, None)

    # ── JSON-RPC send ────────────────────────────────────────────────────────
    def _write(self, obj: dict) -> None:
        self._proc.stdin.write(json.dumps(obj, separators=(",", ":")).encode() + b"\n")

    async def request(self, method, params=None):
        rid = next(self._ids)
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        return await fut

    def notify(self, method, params=None) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    # ── receive loop ─────────────────────────────────────────────────────────
    async def _read_loop(self) -> None:
        out = self._proc.stdout
        while True:
            try:
                line = await out.readline()
            except (asyncio.LimitOverrunError, ValueError):
                continue                    # oversized frame: skip, keep the stream alive
            if not line:                    # EOF — the agent exited/crashed
                for fut in self._pending.values():
                    if not fut.done():
                        fut.set_exception(ConnectionError("ACP agent exited"))
                self._pending.clear()
                return
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue                    # ignore non-JSON noise on stdout
            await self._dispatch(msg)

    async def _dispatch(self, msg: dict) -> None:
        # Response to one of our requests.
        if "id" in msg and ("result" in msg or "error" in msg):
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(RuntimeError(str(msg["error"])))
                else:
                    fut.set_result(msg.get("result"))
            return
        method = msg.get("method")
        params = msg.get("params") or {}
        route = self._routes.get(params.get("sessionId"))
        if "id" in msg:                     # agent -> client REQUEST (fs/*, terminal/*, permission)
            # Handle concurrently: a request may block (terminal/wait_for_exit, a
            # permission prompt), and the read loop must keep reading the agent's
            # other traffic (session/update, more requests) meanwhile.
            asyncio.create_task(self._respond(msg, route, method, params))
        elif method == "session/update" and route is not None:
            route["on_update"](params)      # notification

    async def _respond(self, msg, route, method, params) -> None:
        try:
            if route is None:
                raise RuntimeError(f"no route for session {params.get('sessionId')!r}")
            result = await route["on_request"](method, params)
            self._write({"jsonrpc": "2.0", "id": msg["id"], "result": result})
        except Exception as exc:            # noqa: BLE001 — surface as a JSON-RPC error
            self._write({"jsonrpc": "2.0", "id": msg["id"],
                         "error": {"code": -32000, "message": str(exc)}})

    async def _drain_stderr(self) -> None:
        err = self._proc.stderr
        while True:
            line = await err.readline()
            if not line:
                return
            print(f"[acp] {line.decode('utf-8', 'replace').rstrip()}", flush=True)
