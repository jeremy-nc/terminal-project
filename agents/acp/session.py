"""AcpSession: one live ACP session on a shared AcpClient.

Owns the session's Transcript, serves the agent's fs/terminal/permission
callbacks, folds `session/update` into the transcript, and runs single prompt
turns. Surface-agnostic: it emits events through an injected ``emit`` callback
(which stamps the owner's key — ``node_id`` for a pipeline node, ``session_id``
for a Collab panel) and narrates via an optional callback, so a pipeline
:class:`AcpNode` and a Collab panel can both drive it without change.

The turn LOOP is the caller's (a pipeline node's finite conversation vs. a
Collab panel's open-ended, user-driven one) — this class exposes ``open`` /
``prompt`` / ``set_mode`` / ``set_model`` / ``close`` and does the rest."""
import asyncio
import os
import secrets

from .terminal import spawn_terminal
from .transcript import Transcript, feed_text, text_of


class AcpSession:
    def __init__(self, client, cwd, *, key=None, key_field="node_id",
                 emit=None, perms=None, permission="auto", on_narrate=None,
                 agent=None, transcript=None):
        self._client = client
        self.cwd = cwd
        self._key = key                    # the owner's id, stamped onto every event
        self._key_field = key_field        # "node_id" (pipeline) | "session_id" (collab)
        self._emit_raw = emit              # callable(event: dict) — broadcast
        self._perms = perms                # permission futures registry (token -> Future)
        self.permission = permission or "auto"
        self._on_narrate = on_narrate      # optional callable(text) — e.g. a terminal tab
        self.transcript = transcript or Transcript(key, None, agent, cwd)
        self.session_id = None
        self._terminals = {}               # ACP terminals opened for the agent
        self._term_seq = 0

    # ── emit / narrate ────────────────────────────────────────────────────────
    def _emit(self, event: dict) -> None:
        # A Collab panel has no id at construction — fall back to the session id
        # (assigned in open() before any emit).
        if self._emit_raw:
            self._emit_raw({**event, self._key_field: self._key or self.session_id})

    def _emit_meta(self, **fields) -> None:
        self._emit({"type": "acp_meta", **fields})

    def _narrate(self, text: str) -> None:
        if self._on_narrate:
            self._on_narrate(text)

    # ── lifecycle ─────────────────────────────────────────────────────────────
    async def open(self, mcps=None) -> str:
        """session/new + route + advertise the session's controls (modes/models)."""
        new = await self._client.request("session/new", {"cwd": self.cwd, "mcpServers": mcps or []})
        self.session_id = new.get("sessionId")
        self.transcript.session_id = self.session_id
        self._client.route(self.session_id, on_update=self._on_update, on_request=self._on_client_call)
        # Start on the agent's "Default (recommended)" model rather than whatever
        # the user's CLI is currently pinned to (e.g. a custom Fable model).
        models = new.get("models") or {}
        avail = models.get("availableModels") or []
        if any(m.get("modelId") == "default" for m in avail) and models.get("currentModelId") != "default":
            try:
                await self._client.request("session/set_model", {"sessionId": self.session_id, "modelId": "default"})
                models = {**models, "currentModelId": "default"}
            except Exception:  # noqa: BLE001 — keep the session even if the switch fails
                pass
        self._emit_meta(modes=new.get("modes"), models=models)
        return self.session_id

    async def prompt(self, text) -> str:
        """Run ONE turn on this session; return its stop reason."""
        result = await self._client.request("session/prompt", {
            "sessionId": self.session_id, "prompt": [{"type": "text", "text": text}]})
        return result.get("stopReason") if isinstance(result, dict) else None

    async def set_mode(self, mode_id) -> None:
        await self._client.request("session/set_mode", {"sessionId": self.session_id, "modeId": mode_id})

    async def set_model(self, model_id) -> None:
        await self._client.request("session/set_model", {"sessionId": self.session_id, "modelId": model_id})

    def cancel(self) -> None:
        """Interrupt the current turn (ACP session/cancel notification). The
        in-flight session/prompt returns with stopReason 'cancelled'."""
        if self.session_id is not None:
            self._client.notify("session/cancel", {"sessionId": self.session_id})

    async def close(self) -> None:
        """Kill this session's terminals and stop routing its traffic."""
        for term in self._terminals.values():
            try:
                await term.kill()
            except Exception:  # noqa: BLE001 — best-effort teardown
                pass
        self._terminals.clear()
        if self.session_id is not None:
            self._client.unroute(self.session_id)

    def record_user(self, text, sender=None) -> None:
        """Record a user prompt (send-to-agent) in the transcript, tagged with the
        sender's presence id, and narrate it."""
        entry = self.transcript.add_user(text, sender)
        self._narrate(f"> {text}\n\n")
        if entry is not None:
            self._emit({"type": "acp_update", "entry": dict(entry)})

    def record_chat(self, sender, text) -> None:
        """Record a broadcast-only chat message (user↔user; not a prompt)."""
        entry = self.transcript.add_chat(sender, text)
        if entry is not None:
            self._emit({"type": "acp_update", "entry": dict(entry)})

    def record_error(self, text) -> None:
        """Surface an agent/transport failure in the transcript."""
        entry = self.transcript.add_error(text)
        self._narrate(f"\n[acp error] {text}\n")
        if entry is not None:
            self._emit({"type": "acp_update", "entry": dict(entry)})

    # ── agent → client updates & callbacks ────────────────────────────────────
    def _on_update(self, params: dict) -> None:
        u = params.get("update", params)
        kind = u.get("sessionUpdate")
        # Session-control updates (not transcript entries): surface to the selectors.
        if kind == "available_commands_update":
            cmds = u.get("availableCommands") or u.get("available_commands") or []
            self._emit_meta(commands=[{"name": c.get("name"), "description": c.get("description")}
                                      for c in cmds])
            return
        if kind == "current_mode_update":
            self._emit_meta(currentModeId=u.get("currentModeId") or u.get("current_mode_id"))
            return
        if kind == "current_model_update":
            self._emit_meta(currentModelId=u.get("currentModelId") or u.get("current_model_id"))
            return
        entry = self.transcript.apply(params)
        text = feed_text(params)
        if text:
            self._narrate(text)
        if entry is not None:
            # Copy the entry: message/tool_call entries mutate in place across
            # chunks, and the transport may serialise lazily — a live reference
            # would let later mutations corrupt this event.
            self._emit({"type": "acp_update", "entry": dict(entry)})

    def _resolve_path(self, path: str) -> str:
        """Resolve an agent-supplied path against cwd and confine it there."""
        base = os.path.abspath(self.cwd or os.getcwd())
        full = os.path.abspath(os.path.join(base, os.path.expanduser(path)))
        if full != base and not full.startswith(base + os.sep):
            raise RuntimeError(f"path escapes workspace: {path}")
        return full

    async def _on_client_call(self, method: str, params: dict):
        """Serve the agent's callbacks: filesystem (confined to cwd), permission
        prompts (auto or HITL), and terminal execution (streamed live)."""
        if method == "fs/read_text_file":
            with open(self._resolve_path(params.get("path", "")), "r", encoding="utf-8") as fh:
                return {"content": fh.read()}
        if method == "fs/write_text_file":
            full = self._resolve_path(params.get("path", ""))
            os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
            with open(full, "w", encoding="utf-8") as fh:
                fh.write(params.get("content", ""))
            return {}
        if method == "session/request_permission":
            return await self._request_permission(params)
        if method.startswith("terminal/"):
            return await self._serve_terminal(method, params)
        raise RuntimeError(f"unsupported ACP method: {method}")

    async def _serve_terminal(self, method: str, params: dict):
        """Serve ACP terminal/*: run the agent's command as our child process and
        stream its output into the transcript (a growing tool block) live."""
        if method == "terminal/create":
            tid = f"term-{self._term_seq}"
            self._term_seq += 1
            cwd = os.path.expanduser(params.get("cwd") or self.cwd or ".")
            cmd_str = " ".join(str(p) for p in [params.get("command"), *(params.get("args") or [])]
                               if p is not None)
            entry = self.transcript.add_tool(cmd_str, tool="terminal", input={"command": cmd_str})

            def _emit():
                self._emit({"type": "acp_update", "entry": dict(entry)})

            def _on_data(chunk):
                text = chunk.decode("utf-8", "replace")
                entry["output"] = (entry.get("output") or "") + text
                _emit()
                self._narrate(text)

            def _on_exit(status):
                entry["status"] = "completed" if (status and status.get("exitCode") == 0) else "failed"
                _emit()

            _emit()  # show the command immediately (running), before any output
            self._terminals[tid] = await spawn_terminal(
                params.get("command"), params.get("args"), cwd,
                params.get("env"), params.get("outputByteLimit"),
                on_data=_on_data, on_exit=_on_exit)
            return {"terminalId": tid}
        term = self._terminals.get(params.get("terminalId"))
        if method == "terminal/output":
            return term.output() if term else {"output": "", "truncated": False, "exitStatus": None}
        if method == "terminal/wait_for_exit":
            return {"exitStatus": await term.wait()} if term else {"exitStatus": None}
        if method == "terminal/kill":
            if term:
                await term.kill()
            return {}
        if method == "terminal/release":
            term = self._terminals.pop(params.get("terminalId"), None)
            if term:
                await term.kill()
            return {}
        raise RuntimeError(f"unsupported ACP method: {method}")

    async def _request_permission(self, params: dict):
        """``permission == "auto"`` picks the first allow-kind option; ``"ask"``
        surfaces an ``acp_permission`` prompt and blocks until a window replies
        (resolved by ``request_id`` token via the shared ``perms`` registry)."""
        options = params.get("options", [])

        def _selected(option_id):
            return {"outcome": {"outcome": "selected", "optionId": option_id}} if option_id \
                else {"outcome": {"outcome": "cancelled"}}

        if self.permission != "ask":
            allow = next((o for o in options if str(o.get("kind", "")).startswith("allow")), None)
            return _selected(allow.get("optionId") if allow else None)

        if self._perms is None:
            return _selected(None)  # can't prompt without a registry — deny safely
        token = secrets.token_hex(4)
        fut = asyncio.get_running_loop().create_future()
        self._perms[token] = fut
        tool = params.get("toolCall") or {}
        self._emit({
            "type": "acp_permission", "request_id": token,
            "title": tool.get("title") or "Permission requested",
            "tool": tool.get("kind"), "content": text_of(tool.get("content")),
            "options": [{"id": o.get("optionId"), "name": o.get("name"), "kind": o.get("kind")}
                        for o in options],
        })
        self._emit({"type": "node_status", "status": "waiting"})
        try:
            option_id = await fut
        finally:
            self._perms.pop(token, None)
        self._emit({"type": "node_status", "status": "running"})
        return _selected(option_id)
