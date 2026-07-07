"""ACP session transcript: a structured, append-only record assembled live from
`session/update` notifications and finalized at the prompt's stop reason. This is
the ACP node's output model — it replaces the end-of-run terminal snapshot with a
stream we accumulate as it arrives. No transport or asyncio concerns live here."""


def _text(content) -> str:
    """Flatten an ACP content value to plain text. Shapes seen in the wild:
    ``{"type":"text","text":...}``, ``{"type":"content","content":<block>}``, a
    list of any of those, or a bare string."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(_text(c) for c in content)
    if isinstance(content, dict):
        if "text" in content:
            return content["text"] or ""
        if "content" in content:
            return _text(content["content"])
    return ""


# Public alias: flatten an ACP content value to text (used for permission previews).
text_of = _text


class Transcript:
    """Fold `session/update` params into ordered entries. Message chunks coalesce
    into the current message entry; tool calls upsert by id."""

    def __init__(self, node_id, session_id, agent, cwd):
        self.node_id = node_id
        self.session_id = session_id
        self.agent = agent
        self.cwd = cwd
        self.status = "running"
        self.stop_reason = None
        self.entries = []
        self._seq = 0
        self._by_tool = {}
        self._cur_msg = None

    def _new(self, kind, **fields):
        entry = {"seq": self._seq, "kind": kind, **fields}
        self._seq += 1
        self.entries.append(entry)
        return entry

    def apply(self, params: dict):
        """Fold one `session/update` (its params) into the record; return the
        entry that changed (for a structured broadcast in Phase 2), or None."""
        u = params.get("update", params)
        kind = u.get("sessionUpdate")
        if kind == "agent_message_chunk":
            if self._cur_msg is None:
                self._cur_msg = self._new("message", role="assistant", text="")
            self._cur_msg["text"] += _text(u.get("content"))
            return self._cur_msg
        # Any non-message update closes the current message run.
        self._cur_msg = None
        if kind == "agent_thought_chunk":
            return self._new("thought", text=_text(u.get("content")))
        if kind in ("tool_call", "tool_call_update"):
            # Agents (e.g. claude-code-acp) emit `tool_call` more than once for the
            # same toolCallId — an empty stub, then filled — and stream further
            # detail via `tool_call_update`. Upsert by id so each tool is ONE entry,
            # never a duplicate stub stacked against the real block.
            tid = u.get("toolCallId")
            entry = self._by_tool.get(tid)
            if entry is None:
                entry = self._new("tool_call", id=tid, title=u.get("title"),
                                  tool=u.get("kind"), status=u.get("status", "pending"),
                                  input=u.get("rawInput"), output="")
                self._by_tool[tid] = entry
            else:
                if u.get("title"):
                    entry["title"] = u["title"]
                if u.get("kind"):
                    entry["tool"] = u["kind"]
                if u.get("status"):
                    entry["status"] = u["status"]
                if u.get("rawInput") is not None:
                    entry["input"] = u["rawInput"]
            if u.get("content"):
                entry["output"] = (entry.get("output") or "") + _text(u["content"])
            return entry
        if kind == "plan":
            return self._new("plan", entries=u.get("entries", []))
        if kind == "diff":
            return self._new("diff", path=u.get("path"), newText=u.get("newText"))
        return None

    def add_user(self, text, sender=None):
        """Record a user prompt (kickoff / follow-up / send-to-agent). ``sender`` is
        the presence id of the window that sent it (None for a system/kickoff).
        Excluded from ``assistant_text``."""
        self._cur_msg = None
        return self._new("user", text=text, sender=sender)

    def add_chat(self, sender, text):
        """A user-to-user chat message — broadcast-only, never sent to the agent —
        tagged with the sender's presence id."""
        self._cur_msg = None
        return self._new("chat", sender=sender, text=text)

    def add_error(self, text):
        """Record an agent/transport failure so it's visible on the card, not just
        the terminal tab."""
        self._cur_msg = None
        return self._new("error", text=text)

    def add_tool(self, title, tool=None, input=None, status="running"):
        """Create a tool_call-style entry from the CLIENT side — e.g. a terminal we
        run for the agent — so it renders in the card (as a tool block) and can
        stream live by mutating its ``output`` and re-emitting the entry."""
        self._cur_msg = None
        return self._new("tool_call", id=None, title=title, tool=tool,
                         status=status, input=input, output="")

    def finalize(self, stop_reason):
        self.status = "done" if stop_reason in (None, "end_turn") else "stopped"
        self.stop_reason = stop_reason

    def assistant_text(self) -> str:
        return "".join(e["text"] for e in self.entries if e["kind"] == "message")

    def to_json(self) -> dict:
        return {
            "nodeId": self.node_id,
            "sessionId": self.session_id,
            "agent": self.agent,
            "status": self.status,
            "stopReason": self.stop_reason,
            "entries": self.entries,
        }


def feed_text(params: dict) -> str:
    """Render ONE raw update to incremental terminal text for the Phase-1 xterm
    card (the rich React card lands in Phase 2). Returns "" for updates carrying
    no incremental text, so nothing double-renders under message coalescing."""
    u = params.get("update", params)
    kind = u.get("sessionUpdate")
    if kind == "agent_message_chunk":
        return _text(u.get("content"))
    if kind == "tool_call":
        return f"\n$ {u.get('title') or u.get('kind') or 'tool'}\n"
    if kind == "tool_call_update":
        return _text(u.get("content")) if u.get("content") else ""
    if kind == "diff":
        return f"\n--- {u.get('path')}\n"
    return ""  # thoughts/plans surface only in the structured card
