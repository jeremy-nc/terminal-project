"""SdkSession: one live Claude session driven by the Claude Agent SDK.

The SDK-backed counterpart to :class:`agents.acp.AcpSession`. Where AcpSession
speaks JSON-RPC to a shared agent subprocess, SdkSession owns its OWN
``ClaudeSDKClient`` (its own Claude Code process) and translates the SDK's typed
message stream (thinking / text / tool_use blocks + tool-result user messages)
into the SAME transcript entries and websocket events. It exposes the identical
surface — ``open`` / ``prompt`` / ``set_mode`` / ``set_model`` / ``cancel`` /
``close`` + ``record_*`` — so a Collab panel (or, later, a pipeline node) can be
backed by either technology and neither CollabRun nor the frontend can tell.

Unlike ACP there is no pool: SDK sessions are independent processes, not many
routes over one client.
"""
import asyncio
import json
import os
import re
import secrets
import uuid

from agents.acp.transcript import Transcript, text_of

try:  # the SDK requires Python >= 3.10; keep this import soft so the module loads
    import claude_agent_sdk as _sdk
except Exception:  # noqa: BLE001 — surfaced clearly when open() is called
    _sdk = None

# SDK built-in tool name -> the card's tool "kind" (see TOOL_VERB in the frontend),
# so an SDK tool call lights up the same 🔍/⚡/📄/✏️/🌐 verb as an ACP one.
_TOOL_KIND = {
    "Bash": "execute", "BashOutput": "execute", "KillShell": "execute", "KillBash": "execute",
    "Read": "read", "NotebookRead": "read",
    "Edit": "edit", "Write": "edit", "MultiEdit": "edit", "NotebookEdit": "edit",
    "Glob": "search", "Grep": "search", "WebSearch": "search",
    "WebFetch": "fetch",
    "Task": "other", "TodoWrite": "other", "ExitPlanMode": "other",
}

# The models offered in the panel's model selector (SDK accepts these ids).
_MODELS = [
    {"modelId": "claude-opus-4-8", "name": "Opus 4.8"},
    {"modelId": "claude-sonnet-4-6", "name": "Sonnet 4.6"},
    {"modelId": "claude-haiku-4-5", "name": "Haiku 4.5"},
]
_DEFAULT_MODEL = "claude-opus-4-8"

# The SDK permission modes offered in the panel's mode selector.
_MODES = [
    {"id": "default", "name": "Default"},
    {"id": "acceptEdits", "name": "Accept edits"},
    {"id": "plan", "name": "Plan"},
    {"id": "bypassPermissions", "name": "Bypass"},
]


def _child_env() -> dict:
    """Environment OVERRIDES for the SDK's child process.

    The SDK's subprocess transport builds the child env as
    ``{**os.environ (minus CLAUDECODE), **options.env}`` — it MERGES our env
    *over* ``os.environ`` (unlike ACP, which passes a fully-replaced ``env=`` to
    the subprocess). So omitting a key here does NOT remove it: the parent's copy
    survives. We therefore return overrides only. When a subscription OAuth token
    is present, blank ``ANTHROPIC_API_KEY`` (an empty value is treated as unset)
    so the child authenticates as the subscription, not a possibly-depleted
    API-key account. (The SDK strips ``CLAUDECODE`` itself, so no nested-session
    guard is needed here.)
    """
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return {"ANTHROPIC_API_KEY": ""}
    return {}


def _tool_kind(name: str) -> str:
    if name and "__delegate" in name:   # our delegate / delegate_map tools
        return "delegate"
    return _TOOL_KIND.get(name, "other")


def _tool_title(name: str, inp: dict) -> str:
    """A concise, human title for a tool call (the card's header line)."""
    inp = inp or {}
    if name and name.endswith("__delegate_map"):
        tasks = inp.get("tasks") or []
        return f"Delegate ×{len(tasks)} in parallel" if tasks else "Delegate (parallel)"
    if name and name.endswith("__delegate"):
        task = inp.get("task") or ""
        return f"Delegate → {task[:60]}" if task else "Delegate"
    if name in ("Bash", "BashOutput", "KillShell", "KillBash"):
        return inp.get("command") or inp.get("description") or name
    if name in ("Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead"):
        path = inp.get("file_path") or inp.get("path") or ""
        return f"{name} {os.path.basename(path)}".strip() if path else name
    if name in ("Glob", "Grep"):
        return inp.get("pattern") or name
    if name == "WebFetch":
        return inp.get("url") or name
    if name == "WebSearch":
        return inp.get("query") or name
    if name == "Task":
        return f"Delegate → {inp.get('subagent_type') or inp.get('description') or 'agent'}"
    if name == "TodoWrite":
        return "Update todos"
    return name


def _parse_ask_answer(choice: str, questions: list):
    """Map an AskUserQuestion reply to a list of (header, answer) pairs. The reply is
    either a JSON map of per-question selected option indices ({"0":[1],"1":[0,2]} —
    supports multiple questions AND multi-select) or the legacy single 'q{qi}o{oi}'."""
    choice = (choice or "").strip()

    def _one(qi, idxs):
        if not (0 <= qi < len(questions)):
            return None
        q = questions[qi] or {}
        opts = q.get("options") or []
        labels = [(opts[i] or {}).get("label") or "" for i in idxs if isinstance(i, int) and 0 <= i < len(opts)]
        labels = [x for x in labels if x]
        if not labels:
            return None
        return (q.get("header") or q.get("question") or "Answer", ", ".join(labels))

    if choice.startswith("{"):
        try:
            sel = json.loads(choice)
        except Exception:  # noqa: BLE001
            return []
        out = []
        for qi_str, idxs in (sel or {}).items():
            try:
                pair = _one(int(qi_str), idxs if isinstance(idxs, list) else [idxs])
            except (TypeError, ValueError):
                pair = None
            if pair:
                out.append(pair)
        return out

    m = re.fullmatch(r"q(\d+)o(\d+)", choice)
    if not m:
        return []
    pair = _one(int(m.group(1)), [int(m.group(2))])
    return [pair] if pair else []


def make_delegate_server(on_delegate):
    """Build an in-process SDK MCP server exposing a single ``delegate`` tool that
    lets an agent hand a sub-task to a sub-agent running in its OWN pane.

    ``on_delegate(task: str) -> str`` is our async callback (CollabRun) that spawns
    and drives the sub-session and returns its result text — which becomes the tool
    result the calling agent receives. Because the handler is our code and can
    block arbitrarily, the sub-session can auto-run, be grabbed by a human, and be
    handed back on a human's signal, all while the caller's turn waits on the tool.
    """
    if _sdk is None:
        return None

    @_sdk.tool(
        "delegate",
        "Delegate ONE self-contained sub-task to a sub-agent that works in its own "
        "pane. Blocks until it returns its result. For SEVERAL independent sub-tasks "
        "at once, prefer `delegate_map` (runs them in parallel).",
        {"task": str},
    )
    async def _delegate(args):
        text = await on_delegate(args.get("task", ""))
        return {"content": [{"type": "text", "text": text or "(no result)"}]}

    @_sdk.tool(
        "delegate_map",
        "Delegate SEVERAL independent sub-tasks at once: each runs on its own "
        "sub-agent IN PARALLEL (its own pane), and their results come back joined and "
        "labelled for YOU to synthesise (map → reduce). Use for fan-out work like "
        "'do <thing> for each of these'. Pass `tasks` as a list of task strings.",
        {"tasks": list},
    )
    async def _delegate_map(args):
        tasks = args.get("tasks") or []
        if not isinstance(tasks, list) or not tasks:
            return {"content": [{"type": "text", "text": "delegate_map needs a non-empty `tasks` list."}]}
        # Fan out concurrently — each on_delegate() spawns+drives its own sub-session
        # (its own lock), so gather runs them genuinely in parallel.
        results = await asyncio.gather(*[on_delegate(str(t)) for t in tasks],
                                       return_exceptions=True)
        parts = []
        for i, (task, res) in enumerate(zip(tasks, results), 1):
            body = res if isinstance(res, str) else f"(failed: {res})"
            parts.append(f"### Result {i} — {str(task)[:100]}\n{body or '(no result)'}")
        return {"content": [{"type": "text", "text": "\n\n".join(parts)}]}

    return _sdk.create_sdk_mcp_server("coordinator", tools=[_delegate, _delegate_map])


# The SDK surfaces built-in subagent (Agent/Task) lifecycle as these messages.
_TASK_KIND = {"TaskStartedMessage": "started", "TaskUpdatedMessage": "updated",
              "TaskNotificationMessage": "finished"}


class SdkSession:
    def __init__(self, cwd, *, key=None, key_field="session_id", emit=None, perms=None,
                 permission="auto", on_narrate=None, agent=None, transcript=None, model=None,
                 mcp_servers=None, disallowed_tools=None, on_subagent=None, mode=None,
                 setting_sources=None, system_prompt=None, thinking=None):
        self.cwd = os.path.abspath(os.path.expanduser(cwd)) if cwd else cwd
        self._key = key
        self._key_field = key_field
        self._emit_raw = emit
        self._perms = perms
        self.permission = permission or "auto"
        # Called with (kind, data) for each built-in subagent lifecycle message —
        # lets the owner mirror the subagent into its own pane. See CollabRun.
        self._on_subagent = on_subagent
        self._on_narrate = on_narrate
        self._mcp_servers = mcp_servers or {}       # extra in-process tools (e.g. delegate)
        self._disallowed_tools = disallowed_tools or []
        # None → default ["project","user"] (load CLAUDE.md + configured MCP servers). Pass
        # [] for a lean session that skips settings/MCP (e.g. the command router).
        self._setting_sources = setting_sources
        # None → default (claude_code preset system prompt + adaptive thinking). A lean
        # router passes a tiny custom system_prompt and thinking={"type":"disabled"} to cut
        # per-turn latency (no giant preset to process, no thinking overhead).
        self._system_prompt = system_prompt
        self._thinking = thinking
        # A stable id we control (used for event keying regardless of the SDK's
        # internal session id, which is only assigned on the first turn).
        self.session_id = str(uuid.uuid4())
        self.transcript = transcript or Transcript(key, self.session_id, agent, self.cwd)
        self._client = None
        self._model = model or _DEFAULT_MODEL
        self._mode = mode or ("bypassPermissions" if self.permission != "ask" else "default")
        self._sdk_session_id = None      # the SDK's own id (captured for fork/resume)
        self._blocks = {}                # content-block index -> live entry, per message

    # ── emit / narrate (identical contract to AcpSession) ─────────────────────
    def _emit(self, event: dict) -> None:
        if self._emit_raw:
            self._emit_raw({**event, self._key_field: self._key or self.session_id})

    def _emit_meta(self, **fields) -> None:
        self._emit({"type": "acp_meta", **fields})

    def _emit_update(self, entry: dict) -> None:
        # Copy: entries mutate in place across deltas and the transport may
        # serialise lazily — a live reference would let later deltas corrupt it.
        self._emit({"type": "acp_update", "entry": dict(entry)})

    def _narrate(self, text: str) -> None:
        if self._on_narrate and text:
            self._on_narrate(text)

    # ── lifecycle ─────────────────────────────────────────────────────────────
    async def open(self, mcps=None, resume=None, fork=False) -> str:
        """Connect a fresh ClaudeSDKClient and advertise the panel's controls.

        When ``resume`` (a prior SDK session id) is given with ``fork=True``, this
        is a GENUINE fork: the SDK resumes that session's full real transcript
        (every message, tool call, thinking block, the true model context) into a
        NEW session and diverges — the source is untouched. This is stronger than
        the text-snapshot approach the ACP path still uses (which only pastes the
        prior assistant text into a fresh session's first prompt)."""
        if _sdk is None:
            raise RuntimeError("claude-agent-sdk is not installed (requires Python >= 3.10)")
        opts = _sdk.ClaudeAgentOptions(
            system_prompt=(self._system_prompt if self._system_prompt is not None
                           else {"type": "preset", "preset": "claude_code"}),
            setting_sources=(self._setting_sources if self._setting_sources is not None else ["project", "user"]),
            permission_mode=self._mode,
            include_partial_messages=True,         # stream thinking/text/tool-input deltas
            model=self._model,
            cwd=self.cwd,
            thinking=(self._thinking if self._thinking is not None else {"type": "adaptive", "display": "summarized"}),
            can_use_tool=self._can_use_tool if self.permission == "ask" else None,
            resume=resume,
            fork_session=fork,
            mcp_servers=self._mcp_servers or None,
            disallowed_tools=self._disallowed_tools or None,
            env=_child_env(),
        )
        self._client = _sdk.ClaudeSDKClient(options=opts)
        await self._client.connect()
        self._emit_meta(
            modes={"availableModes": _MODES, "currentModeId": self._mode},
            models={"availableModels": _MODELS, "currentModelId": self._model},
        )
        await self._advertise_commands()
        return self.session_id

    async def _advertise_commands(self) -> None:
        """Publish the agent's slash commands to the panel's "/" menu. Fetched via
        get_server_info at connect time — so they're available IMMEDIATELY (before
        the first prompt), with descriptions — rather than waiting for the first
        turn's init message (which lists bare names only)."""
        try:
            info = await self._client.get_server_info() or {}
        except Exception:  # noqa: BLE001 — the "/" menu is a nicety; never fail open()
            return
        menu = [{"name": c.get("name"), "description": c.get("description")}
                for c in (info.get("commands") or []) if isinstance(c, dict) and c.get("name")]
        if menu:
            self._emit_meta(commands=menu)

    def fork_ref(self):
        """The SDK session id to resume-and-fork FROM, enabling a genuine fork —
        or None if this session hasn't run a turn yet (its real id is assigned on
        the first prompt's init message). CollabRun checks for this method to
        decide between a genuine fork and the snapshot fallback."""
        return self._sdk_session_id

    async def prompt(self, text) -> str:
        """Run ONE turn: send the prompt, fold the streamed reply into the
        transcript, and return the turn's stop reason."""
        self._blocks = {}
        await self._client.query(text)
        stop = None
        async for msg in self._client.receive_response():
            stop = self._translate(msg) or stop
        return stop

    async def warmup(self) -> None:
        """Prime the connection past the one-time first-turn penalty (the subscription
        rate-limit check etc.) WITHOUT emitting anything, so the next real turn is faster.
        Used to warm a pre-fetched command-router session in the background."""
        try:
            await self._client.query("Respond with the single word: ready")
            async for _ in self._client.receive_response():
                pass
        except Exception:  # noqa: BLE001 — best-effort; a failed warmup just means no speedup
            pass

    async def set_mode(self, mode_id) -> None:
        self._mode = mode_id
        await self._client.set_permission_mode(mode_id)
        self._emit_meta(currentModeId=mode_id)  # SDK doesn't echo — reflect it ourselves

    async def set_model(self, model_id) -> None:
        self._model = model_id
        await self._client.set_model(model_id)
        self._emit_meta(currentModelId=model_id)

    def cancel(self) -> None:
        """Interrupt the current turn (SDK interrupt is async — fire-and-forget)."""
        if self._client is not None:
            asyncio.create_task(self._client.interrupt())

    async def stop_task(self, task_id) -> None:
        """Stop ONE running built-in subagent (Agent/Task) by its task id — used to
        halt an autonomous subagent so a human can resume its session and take over."""
        if self._client is not None:
            await self._client.stop_task(task_id)

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001 — best-effort teardown
                pass
            self._client = None

    def record_user(self, text, sender=None) -> None:
        entry = self.transcript.add_user(text, sender)
        self._narrate(f"> {text}\n\n")
        if entry is not None:
            self._emit_update(entry)

    def record_chat(self, sender, text) -> None:
        entry = self.transcript.add_chat(sender, text)
        if entry is not None:
            self._emit_update(entry)

    def record_error(self, text) -> None:
        entry = self.transcript.add_error(text)
        self._narrate(f"\n[sdk error] {text}\n")
        if entry is not None:
            self._emit_update(entry)

    # ── SDK stream translation ────────────────────────────────────────────────
    def _translate(self, msg):
        """Fold one SDK message into the transcript; return a stop reason at the
        turn boundary (ResultMessage), else None."""
        cls = type(msg).__name__
        if cls == "StreamEvent":
            self._on_stream(getattr(msg, "event", None) or {})
            return None
        if cls == "AssistantMessage":
            # Content is normally built from the stream deltas; but a synthetic
            # ERROR turn (e.g. `error='billing_error'` — "Credit balance is too
            # low") arrives ONLY as an AssistantMessage with no stream. Surface it
            # so the failure isn't silently dropped and the panel just goes idle.
            err = getattr(msg, "error", None)
            if err:
                text = "".join(getattr(b, "text", "") for b in (getattr(msg, "content", None) or [])
                               if type(b).__name__ == "TextBlock")
                self.record_error(text or str(err))
            return None
        if cls == "UserMessage":
            self._on_tool_results(getattr(msg, "content", None) or [])
            return None
        if cls == "SystemMessage":
            data = getattr(msg, "data", None) or {}
            if data.get("subtype") == "init":
                self._sdk_session_id = data.get("session_id")
            return None
        if cls in _TASK_KIND:
            # A built-in subagent's lifecycle (Agent/Task): started/updated/finished.
            # Hand it to the owner so it can mirror the subagent into its own pane.
            if self._on_subagent:
                self._on_subagent(_TASK_KIND[cls], getattr(msg, "data", None) or {})
            return None
        if cls == "ResultMessage":
            return getattr(msg, "stop_reason", None) or "end_turn"
        return None

    def _on_stream(self, event: dict) -> None:
        et = event.get("type")
        if et == "message_start":
            self._blocks = {}  # a new message within the turn — block indexes reset
        elif et == "content_block_start":
            self._start_block(event.get("index"), event.get("content_block") or {})
        elif et == "content_block_delta":
            self._delta_block(event.get("index"), event.get("delta") or {})
        elif et == "content_block_stop":
            self._stop_block(event.get("index"))

    def _start_block(self, idx, cb: dict) -> None:
        bt = cb.get("type")
        if bt == "thinking":
            self._blocks[idx] = ("thought", self.transcript.new_thought())
        elif bt == "text":
            self._blocks[idx] = ("text", self.transcript.new_message())
        elif bt == "tool_use":
            entry = self.transcript.new_tool(cb.get("id"), title=cb.get("name"),
                                             tool=_tool_kind(cb.get("name")), status="pending")
            self._blocks[idx] = ("tool", entry, {"name": cb.get("name"), "json": ""})
            self._emit_update(entry)

    def _delta_block(self, idx, delta: dict) -> None:
        blk = self._blocks.get(idx)
        if not blk:
            return
        dt = delta.get("type")
        if dt == "thinking_delta" and blk[0] == "thought":
            blk[1]["text"] += delta.get("thinking", "")
            self._emit_update(blk[1])
        elif dt == "text_delta" and blk[0] == "text":
            chunk = delta.get("text", "")
            blk[1]["text"] += chunk
            self._narrate(chunk)
            self._emit_update(blk[1])
        elif dt == "input_json_delta" and blk[0] == "tool":
            blk[2]["json"] += delta.get("partial_json", "")

    def _stop_block(self, idx) -> None:
        blk = self._blocks.get(idx)
        if not blk or blk[0] != "tool":
            return
        entry, meta = blk[1], blk[2]
        raw = meta["json"]
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:  # noqa: BLE001 — keep the raw args if not valid JSON
            parsed = {"_raw": raw}
        entry["input"] = parsed
        entry["title"] = _tool_title(meta["name"], parsed)
        self._emit_update(entry)

    def _on_tool_results(self, content) -> None:
        for block in content:
            if type(block).__name__ != "ToolResultBlock":
                continue
            out = text_of(getattr(block, "content", None))
            status = "failed" if getattr(block, "is_error", False) else "completed"
            entry = self.transcript.tool_result(getattr(block, "tool_use_id", None), out, status)
            if entry is not None:
                self._emit_update(entry)

    # ── permission (HITL, mirrors AcpSession._request_permission) ─────────────
    async def _can_use_tool(self, tool_name, tool_input, context):
        """Ask the humans: emit an ``acp_permission`` prompt and block on a reply,
        resolved by request-id token via the shared ``perms`` registry."""
        # Auto-allow our own delegation tools (`delegate` / `delegate_map`) — they're
        # coordination primitives, not side-effecting actions, and the sub-panes they
        # spawn have their own approvals.
        if tool_name and "__delegate" in str(tool_name):
            return _sdk.PermissionResultAllow()
        # [collab-command] the control agent's own tools are safe coordination primitives
        if tool_name and "collab_control" in str(tool_name):
            return _sdk.PermissionResultAllow()
        if self._perms is None:
            return _sdk.PermissionResultDeny(message="no approver available")
        # AskUserQuestion isn't a real headless tool — render it as an interactive
        # question (nice UI, clickable answers) and feed the human's pick back to the
        # agent as the tool's result (via a deny-with-message, the only channel a
        # permission hook has to return text).
        if str(tool_name) == "AskUserQuestion":
            return await self._ask_user_question(tool_input)
        token = secrets.token_hex(4)
        fut = asyncio.get_running_loop().create_future()
        self._perms[token] = fut
        preview = json.dumps(tool_input, indent=2)[:600] if tool_input else ""
        self._emit({
            "type": "acp_permission", "request_id": token,
            "title": _tool_title(tool_name, tool_input) or tool_name,
            "tool": _tool_kind(tool_name), "content": preview,
            "options": [{"id": "allow", "name": "Allow", "kind": "allow_once"},
                        {"id": "deny", "name": "Deny", "kind": "reject_once"}],
        })
        self._emit({"type": "node_status", "status": "waiting"})
        try:
            choice = await fut
        finally:
            self._perms.pop(token, None)
        # Resolved (any window answered) — clear the prompt for EVERYONE.
        self._emit({"type": "acp_permission_clear", "request_id": token})
        self._emit({"type": "node_status", "status": "running"})
        if choice in ("allow", "allow_always"):
            return _sdk.PermissionResultAllow()
        return _sdk.PermissionResultDeny(message="denied by user")

    async def _ask_user_question(self, tool_input) -> "object":
        """Surface an AskUserQuestion tool call as an interactive question and return the
        human's selection to the agent. The pick arrives as an option id 'q{qi}o{oi}'."""
        questions = (tool_input or {}).get("questions") or []
        token = secrets.token_hex(4)
        fut = asyncio.get_running_loop().create_future()
        self._perms[token] = fut
        self._emit({
            "type": "acp_permission", "request_id": token, "tool": "ask",
            "title": "The agent is asking", "questions": questions,
            "options": [{"id": "__dismiss", "name": "Dismiss", "kind": "reject_once"}],
        })
        self._emit({"type": "node_status", "status": "waiting"})
        try:
            choice = await fut
        finally:
            self._perms.pop(token, None)
        self._emit({"type": "acp_permission_clear", "request_id": token})
        self._emit({"type": "node_status", "status": "running"})
        answers = _parse_ask_answer(choice, questions)
        if not answers:
            return _sdk.PermissionResultDeny(message="The user dismissed the question without answering.")
        picks = "; ".join(f"{h}: {label}" for h, label in answers)
        return _sdk.PermissionResultDeny(
            message=(f"[Answered by the user] {picks}. Treat this as the answer to your "
                     f"AskUserQuestion and continue — do not ask it again."))
