"""CollabRun: the runtime for a Collab workspace.

One ACP agent process (an :class:`AcpPool` holding a single client for the chosen
agent), and MANY :class:`AcpSession`s — one per "Agent panel" — added at runtime.
Each session carries a shared, multi-user chat: user messages are broadcast to
every window (tagged with the sender's presence id), and only *send-to-agent*
messages become prompt turns (serialized per session).

Mirrors PipelineRun's ``(.task, .event_log, .send)`` contract so the existing
workspace teardown (cancel/delete) and sync-replay handle it unchanged: ``.task``
is a keepalive that lives until the workspace is closed, then tears everything
down; every event is stamped with ``workspace_id``, logged, and broadcast."""
import asyncio
import os
import secrets

from agents.acp import AcpPool, AcpSession, Transcript
from agents.sdk import SdkSession, make_delegate_server

# Agents driven in-process by the Claude Agent SDK (no ACP subprocess / pool).
SDK_AGENTS = {"claude-sdk"}

# Built-in tools we disable so the ONLY way to spawn a sub-agent is our visible,
# blocking `delegate` tool: `Task`/`Agent` (opaque, POOLED subagent the coordinator
# owns + re-runs on interrupt — fragments a take-over), `Workflow` (fire-and-forget
# background fan-out), `RemoteTrigger` (cloud agents out-of-band).
_SDK_DISALLOWED = ["Task", "Agent", "Workflow", "RemoteTrigger"]

# How deep visible delegation may nest (a coordinator at depth 0 delegates to a
# sub at depth 1, which may delegate to depth 2; depth 2 gets no `delegate` tool).
MAX_DELEGATION_DEPTH = 2


class CollabRun:
    def __init__(self, transport, workspace_id, agent, cwd):
        self._transport = transport
        self.workspace_id = workspace_id
        self.agent = agent
        # A workspace stores its dir raw (a directory kind keeps the ~ for display).
        # Expand it here so the agent subprocess/session get a real absolute cwd.
        self.cwd = os.path.abspath(os.path.expanduser(cwd)) if cwd else cwd
        self.event_log = []           # broadcast events, replayed to a late-joining window
        self.task = None              # keepalive task; cancel -> close()
        self.acp = AcpPool()          # holds the one agent process
        self.acp_perms = {}           # token -> Future (permission), shared with AcpSession
        self.acp_sessions = {}        # session_id -> (client, session_id) for set_mode/model
        self.sessions = {}            # session_id -> AcpSession (the panels)
        self._locks = {}              # session_id -> asyncio.Lock (serialize turns)
        self._client = None
        self.session_meta = {}        # session_id -> latest merged {modes, models, commands, ...}
        self._depth = {}              # session_id -> delegation depth (0 = a top-level panel)
        self._parent = {}             # sub session_id -> the session that delegated it
        self._delegations = {}        # sub session_id -> {grabbed, release Future, parent}
        self.mirrors = {}             # subagent session_id -> mirror {task_id, parent, transcript, ...}
        self._takeovers = {}          # taken-over mirror session_id -> {parent, description}
        self._closed = False          # close() is idempotent (may be called by cancel + stop)
        self.annotations = {}         # session_id -> [ {id, seq, text, note, by} ] review notes
        self.prompt_items = {}        # session_id -> [ {id, kind, text, note, by} ] external prompt material
        self.editor_agents = {}       # session_id -> {file, primed} markdown-editor agents (not panels)
        self._editor_by_file = {}     # realpath(file) -> session_id, so an editor agent is SHARED per file
        self._doc_logs = {}           # file -> [b64 Yjs update] replay log for collaborative doc editing
        self._doc_seen = set()        # files that have an active Y.Doc (so the FIRST joiner seeds from disk)

    # ── broadcast contract (mirrors PipelineRun.send) ─────────────────────────
    def send(self, event: dict) -> None:
        event = {**event, "workspace_id": self.workspace_id}
        # Cache the latest per-session controls so a late-joining window can be
        # handed the FULL merged meta directly (belt-and-suspenders vs. replay
        # ordering races that could leave `commands` unset).
        if event.get("type") == "acp_meta" and event.get("session_id"):
            m = self.session_meta.setdefault(event["session_id"], {})
            for k in ("modes", "models", "commands", "currentModeId", "currentModelId"):
                if k in event:
                    m[k] = event[k]
        self.event_log.append(event)
        self._transport.send(event)

    def resend_meta(self, transport) -> None:
        """Send each session's cached, fully-merged controls to one window."""
        for sid, m in self.session_meta.items():
            transport.send({"type": "acp_meta", "workspace_id": self.workspace_id,
                            "session_id": sid, **m})

    async def serve(self) -> None:
        """Keepalive: live until the workspace is closed (task cancelled), then
        tear down all sessions + the agent process."""
        try:
            await asyncio.Event().wait()
        finally:
            await self.close()

    async def close(self) -> None:
        """Tear down every session (SDK `claude` subprocess / ACP pool). Idempotent
        and CONCURRENT with a per-session timeout: closing sessions one-by-one meant
        a single slow disconnect could starve the rest — especially when this runs
        inside a cancelled task's finally, where a long await can be interrupted
        before later sessions are reached. Prefer calling this from a fresh task."""
        if self._closed:
            return
        self._closed = True
        # Unblock any coordinator waiting on a delegation so those turns unwind.
        for d in self._delegations.values():
            if not d["release"].done():
                d["release"].set_result("(workspace closed)")
        self._delegations.clear()
        self.mirrors.clear()
        self._doc_logs.clear()
        self._doc_seen.clear()
        sessions = list(self.sessions.values())
        self.sessions.clear()

        async def _close_one(sess):
            try:
                await asyncio.wait_for(sess.close(), timeout=10)  # disconnect escalates to kill
            except Exception:  # noqa: BLE001 — best-effort teardown
                pass

        if sessions:
            await asyncio.gather(*[_close_one(s) for s in sessions])
        try:
            await self.acp.close()  # kill the ACP agent subprocess (if any)
        except Exception:  # noqa: BLE001
            pass

    # ── sessions (panels) ─────────────────────────────────────────────────────
    async def _ensure_client(self):
        if self._client is None:
            self._client = await self.acp.get(self.agent, self.cwd)
        return self._client

    async def add_session(self, kickoff: str = None, fork_ref: str = None,
                          parent: str = None, depth: int = 0):
        """Open a new session/panel — an in-process SdkSession for an SDK agent, or
        an AcpSession on the shared agent client for an ACP agent. Both expose the
        same interface and emit the same events; the panel can't tell which.

        ``fork_ref`` (an SDK session id) triggers a GENUINE fork for SDK agents —
        the new session resumes the source's real transcript and diverges.
        ``parent``/``depth`` mark a delegated sub-agent pane (spawned by another
        session's ``delegate`` tool); SDK sessions below the nesting cap get their
        own ``delegate`` tool (and never the opaque built-in ``Task``)."""
        sess = None
        try:
            if self.agent in SDK_AGENTS:
                sess = SdkSession(self.cwd, key=None, key_field="session_id",
                                  emit=self.send, perms=self.acp_perms, permission="ask",
                                  agent=self.agent, disallowed_tools=_SDK_DISALLOWED)
                # (Kept but dormant: the built-in-subagent mirror hook; no TaskStarted
                # fires while Agent/Task are disallowed.)
                sess._on_subagent = (lambda kind, data, p=sess.session_id:
                                     self._on_subagent(p, kind, data))
                # Give it a `delegate` tool (interactive sub with clean hand-back)
                # bound to its own id as parent, unless we've hit the nesting cap.
                if depth < MAX_DELEGATION_DEPTH:
                    server = make_delegate_server(
                        lambda task, p=sess.session_id, d=depth: self._run_delegation(p, task, d + 1))
                    if server:
                        sess._mcp_servers = {"coordinator": server}
                sid = await sess.open(resume=fork_ref, fork=bool(fork_ref))
            else:
                client = await self._ensure_client()
                sess = AcpSession(client, self.cwd, key=None, key_field="session_id",
                                  emit=self.send, perms=self.acp_perms, permission="ask",
                                  agent=self.agent)
                sid = await sess.open(mcps=[])
                self.acp_sessions[sid] = (client, sid)
            self.sessions[sid] = sess
            self._locks[sid] = asyncio.Lock()
            self._depth[sid] = depth
            if parent is not None:
                self._parent[sid] = parent
            self.send({"type": "collab_session_added", "session_id": sid, "agent": self.agent,
                       "parent": parent})
            if kickoff:
                await self.prompt(sid, kickoff, sender=None)
            return sid
        except Exception as exc:  # noqa: BLE001 — surface spawn/session failures
            self.send({"type": "collab_error", "message": str(exc)})
            if sess is not None:  # a half-opened session leaks its subprocess — close it
                try:
                    await sess.close()
                except Exception:  # noqa: BLE001
                    pass
            return None

    # ── delegation (visible sub-agents in their own panes) ────────────────────
    async def _run_delegation(self, parent_sid: str, task: str, depth: int) -> str:
        """Spawn a sub-agent pane for ``task``, auto-run it, and return its result
        to the delegating agent (as its tool result). Auto-returns when the sub
        finishes untouched; if a human "takes over" (interrupts) mid-run, the sub
        becomes human-gated and this waits for an explicit "return to coordinator".
        The sub pane persists either way. Blocks the caller's turn throughout —
        which is the point: the caller is waiting on delegated work."""
        sub_sid = await self.add_session(parent=parent_sid, depth=depth)
        if sub_sid is None:
            return "Failed to spawn the sub-agent."
        fut = asyncio.get_running_loop().create_future()
        self._delegations[sub_sid] = {"grabbed": False, "release": fut, "parent": parent_sid}
        self.send({"type": "collab_delegation", "session_id": sub_sid, "parent": parent_sid,
                   "status": "auto", "task": task})
        await self.prompt(sub_sid, task, sender=None)  # auto-run the delegated task
        d = self._delegations.get(sub_sid)
        if d is not None and not d["grabbed"]:
            self._delegations.pop(sub_sid, None)
            result = self.sessions[sub_sid].transcript.assistant_text()
            self.send({"type": "collab_delegation", "session_id": sub_sid,
                       "status": "returned", "auto": True})
            return result or "(sub-agent produced no output)"
        # Human-gated: a human grabbed it — wait for their explicit hand-back.
        result = await fut
        self._delegations.pop(sub_sid, None)
        self.send({"type": "collab_delegation", "session_id": sub_sid,
                   "status": "returned", "auto": False})
        return result or "(no result)"

    # ── mirror built-in subagents (Agent/Task) into read-only panes ───────────
    def _on_subagent(self, parent_sid: str, kind: str, data: dict) -> None:
        """Fold a coordinator's built-in subagent lifecycle into a read-only mirror
        pane (keyed by the subagent's own session id, so a later take-over can
        resume it). We only get start/status/final-summary from the stream — the
        subagent's internal steps aren't streamed — so the mirror shows the task,
        a running indicator, then the result."""
        sub_sid = data.get("session_id")
        if not sub_sid:
            return
        if kind == "started":
            if sub_sid in self.sessions:
                return  # already taken over — the coordinator is reusing our live session
            desc = data.get("description") or "subagent"
            prompt = data.get("prompt") or desc
            m = self.mirrors.get(sub_sid)
            if m is None:
                # First task for this subagent session — open the mirror pane.
                tr = Transcript(sub_sid, sub_sid, self.agent, self.cwd)
                m = {"task_id": data.get("task_id"), "parent": parent_sid,
                     "transcript": tr, "description": desc}
                self.mirrors[sub_sid] = m
                entry = tr.add_user(prompt, None)  # show the task it was given
                self.send({"type": "collab_session_added", "session_id": sub_sid,
                           "agent": self.agent, "parent": parent_sid, "mirror": True})
                self.send({"type": "acp_update", "session_id": sub_sid, "entry": dict(entry)})
                self.send({"type": "collab_delegation", "session_id": sub_sid, "parent": parent_sid,
                           "status": "watching", "task": desc})
            else:
                # The SDK POOLS one subagent session across several Agent calls
                # (3 haikus -> 3 tasks, same session). Track the LIVE task_id so a
                # take-over stops the task that's actually running, and show the new
                # task in the same pane instead of dropping it.
                m["task_id"] = data.get("task_id")
                m["description"] = desc
                entry = m["transcript"].add_user(prompt, None)
                self.send({"type": "acp_update", "session_id": sub_sid, "entry": dict(entry)})
            self.send({"type": "node_status", "session_id": sub_sid, "status": "running"})
        elif kind == "updated":
            if sub_sid in self.mirrors and data.get("status"):
                done = data["status"] in ("completed", "failed", "stopped", "cancelled")
                self.send({"type": "node_status", "session_id": sub_sid,
                           "status": "idle" if done else "running"})
        elif kind == "finished":
            m = self.mirrors.get(sub_sid)
            if m is None:
                return  # already taken over, or unknown
            summary = data.get("summary") or ""
            if summary:
                entry = m["transcript"].new_message()
                entry["text"] = summary
                self.send({"type": "acp_update", "session_id": sub_sid, "entry": dict(entry)})
            # Stay "watching" (just idle) — a pooled subagent may get another task;
            # we only leave this state when a human takes it over.
            self.send({"type": "node_status", "session_id": sub_sid, "status": "idle"})

    async def take_over(self, session_id: str) -> None:
        """A human grabs a running sub-agent.

        For a MIRROR of a built-in subagent: stop the autonomous subagent
        (``stop_task``) and resume its session as OUR interactive pane (same pane
        id + transcript), so the human can drive it. For our own DELEGATE sub:
        interrupt its auto turn and switch it to human-gated (waits for a return)."""
        m = self.mirrors.pop(session_id, None)
        if m is not None:
            coord = self.sessions.get(m["parent"])
            sess = None
            try:
                if coord is not None and m.get("task_id"):
                    await coord.stop_task(m["task_id"])
                    await asyncio.sleep(0.3)  # let the subagent session flush before resume
                sess = SdkSession(self.cwd, key=session_id, key_field="session_id",
                                  emit=self.send, perms=self.acp_perms, permission="ask",
                                  agent=self.agent, transcript=m["transcript"],
                                  disallowed_tools=_SDK_DISALLOWED)
                sess._on_subagent = (lambda kind, data, p=session_id: self._on_subagent(p, kind, data))
                await sess.open(resume=session_id)  # resume the subagent's real context
                self.sessions[session_id] = sess
                self._locks[session_id] = asyncio.Lock()
                self._parent[session_id] = m["parent"]
                self._takeovers[session_id] = {"parent": m["parent"], "description": m["description"]}
                self.send({"type": "collab_delegation", "session_id": session_id, "status": "human-gated"})
            except Exception as exc:  # noqa: BLE001 — surface resume/stop failures
                self.send({"type": "collab_error", "message": f"take over failed: {exc}"})
                if sess is not None and session_id not in self.sessions:
                    try:
                        await sess.close()  # don't leak the half-opened resume client
                    except Exception:  # noqa: BLE001
                        pass
            return
        d = self._delegations.get(session_id)
        if d is not None and not d["grabbed"]:
            d["grabbed"] = True
            self.cancel(session_id)
            self.send({"type": "collab_delegation", "session_id": session_id, "status": "human-gated"})

    async def return_to_coordinator(self, session_id: str, summary: str = None) -> None:
        """Hand a sub's result back to the coordinator/source.

        DELEGATE sub: resolve its pending tool result (clean, transparent). Taken-
        over MIRROR or a user-forked EXPLORER: no pending tool call, so re-inject the
        result as a fresh prompt on the source session."""
        tk = self._takeovers.pop(session_id, None)
        if tk is not None:
            sess = self.sessions.get(session_id)
            result = summary or (sess.transcript.assistant_text() if sess else "")
            self.send({"type": "collab_delegation", "session_id": session_id, "status": "returned"})
            if tk["parent"] in self.sessions:
                note = (f"[A sub-agent working on '{tk['description']}' returned this result:\n\n"
                        f"{result}\n\nIncorporate it and continue.]")
                await self.prompt(tk["parent"], note, sender=None)
            return
        d = self._delegations.get(session_id)
        if d is not None and d["grabbed"] and not d["release"].done():
            sess = self.sessions.get(session_id)
            result = summary or (sess.transcript.assistant_text() if sess else "")
            d["release"].set_result(result)

    async def explore_from_selection(self, from_session_id: str, text: str, note: str,
                                     sender: str = None):
        """Fork a sub-agent to EXPLORE a highlighted excerpt WITHOUT holding up the
        source agent. It runs in its own pane, carries the source's context (a
        genuine fork when the source is an SDK session that has run a turn), auto-runs
        the exploration, and can hand findings back via 'Return to coordinator'."""
        src = self.sessions.get(from_session_id)
        if src is None:
            return None
        fork_ref = src.fork_ref() if hasattr(src, "fork_ref") else None
        depth = self._depth.get(from_session_id, 0) + 1
        sub_sid = await self.add_session(fork_ref=fork_ref, parent=from_session_id, depth=depth)
        if sub_sid is None:
            return None
        # Register for Return-to-coordinator (re-prompts the source), and mark the
        # pane human-gated so the Return button shows.
        self._takeovers[sub_sid] = {"parent": from_session_id, "description": f"explore: {(text or '')[:50]}"}
        self.send({"type": "collab_delegation", "session_id": sub_sid, "parent": from_session_id,
                   "status": "human-gated"})
        instruction = (note or "").strip() or "Explore this further and report back."
        excerpt = (text or "").strip()
        seed = (f"From the previous response, focus on this excerpt:\n\n> {excerpt}\n\n{instruction}"
                if excerpt else instruction)
        await self.prompt(sub_sid, seed, sender=sender)
        return sub_sid

    async def prompt(self, session_id: str, text: str, sender: str = None) -> None:
        """Send-to-agent: record the prompt (tagged with sender) and run ONE turn.
        Serialized per session so concurrent sends queue FIFO."""
        sess = self.sessions.get(session_id)
        if sess is None:
            return
        sess.record_user(text, sender)
        async with self._locks[session_id]:
            self.send({"type": "node_status", "session_id": session_id, "status": "running"})
            try:
                await sess.prompt(text)
            except Exception as exc:  # noqa: BLE001
                sess.record_error(str(exc))
            finally:
                self.send({"type": "node_status", "session_id": session_id, "status": "idle"})
                # A new response landed → pending external prompt items (e.g. suggested
                # edits) are stale, like annotations that are no longer the latest
                # response. Clear them (no-op + no broadcast when there are none).
                self.clear_prompt_items(session_id)

    def chat(self, session_id: str, text: str, sender: str) -> None:
        """A broadcast-only chat message (not sent to the agent)."""
        sess = self.sessions.get(session_id)
        if sess is not None:
            sess.record_chat(sender, text)

    # ── review annotations (highlighted text + note, compiled into next prompt) ─
    def _broadcast_annotations(self, session_id: str) -> None:
        self.send({"type": "collab_annotations", "session_id": session_id,
                   "annotations": list(self.annotations.get(session_id, []))})

    def add_annotation(self, session_id: str, seq, start, end, text: str, note: str,
                       by: str = None, kind: str = "add") -> None:
        """Save a review annotation (highlighted snippet + the user's note) on a
        session, shared with every window. ``start``/``end`` are text offsets within
        the message (seq) so the snippet can be re-highlighted precisely. ``kind``:
        "add" (amber; compiled into the next prompt) or "fork" (blue; a record of a
        forked exploration — never included in the prompt). Annotations PERSIST per
        response; only the latest response's "add" ones are offered for inclusion."""
        if session_id not in self.sessions:
            return
        self.annotations.setdefault(session_id, []).append({
            "id": secrets.token_hex(4), "seq": seq, "start": start, "end": end,
            "text": text or "", "note": note or "", "by": by, "kind": kind or "add"})
        self._broadcast_annotations(session_id)

    def remove_annotation(self, session_id: str, ann_id: str) -> None:
        lst = self.annotations.get(session_id)
        if lst:
            self.annotations[session_id] = [a for a in lst if a.get("id") != ann_id]
            self._broadcast_annotations(session_id)

    def update_annotation(self, session_id: str, ann_id: str, note: str) -> None:
        lst = self.annotations.get(session_id)
        if lst:
            for a in lst:
                if a.get("id") == ann_id:
                    a["note"] = note or ""
                    self._broadcast_annotations(session_id)
                    return

    def clear_annotations(self, session_id: str) -> None:
        if self.annotations.get(session_id):
            self.annotations[session_id] = []
            self._broadcast_annotations(session_id)

    # ── prompt inbox items (external "suggested edit" material, shared like annotations) ─
    def _broadcast_prompt_items(self, session_id: str) -> None:
        self.send({"type": "collab_prompt_items", "session_id": session_id,
                   "items": list(self.prompt_items.get(session_id, []))})

    def add_prompt_item(self, session_id: str, kind: str, text: str, note: str, by: str = None) -> None:
        """Push external prompt material (e.g. a doc selection → a suggested edit) onto a
        session, shared with every window, exactly like an annotation."""
        if session_id not in self.sessions:
            return
        self.prompt_items.setdefault(session_id, []).append({
            "id": secrets.token_hex(4), "kind": kind or "edit",
            "text": text or "", "note": note or "", "by": by})
        self._broadcast_prompt_items(session_id)

    def remove_prompt_item(self, session_id: str, item_id: str) -> None:
        lst = self.prompt_items.get(session_id)
        if lst:
            self.prompt_items[session_id] = [i for i in lst if i.get("id") != item_id]
            self._broadcast_prompt_items(session_id)

    def clear_prompt_items(self, session_id: str) -> None:
        if self.prompt_items.get(session_id):
            self.prompt_items[session_id] = []
            self._broadcast_prompt_items(session_id)

    # ── markdown-editor agent (lives in the editor modal, edits the open file) ─
    async def open_editor_agent(self, file_path: str) -> str:
        """A dedicated SdkSession whose sole job is the open markdown file. cwd is the
        file's folder and it runs in ``acceptEdits`` mode so it edits without asking;
        it is NOT a Collab panel (never emits collab_session_added). Returns its id.

        SHARED per file: everyone who opens the same file attaches to the SAME session
        (same transcript + collaborative prompt draft), so the editor agent is part of
        the one workspace session model. It persists until the Collab session stops."""
        real = os.path.realpath(os.path.expanduser(file_path))
        existing = self._editor_by_file.get(real)
        if existing is not None and existing in self.sessions:
            return existing
        cwd = os.path.dirname(os.path.abspath(os.path.expanduser(file_path))) or "."
        sess = SdkSession(cwd, key=None, key_field="session_id", emit=self.send,
                          perms=self.acp_perms, permission="ask", agent="claude-sdk",
                          disallowed_tools=["Task", "Agent", "Workflow", "RemoteTrigger"],
                          mode="acceptEdits")
        try:
            sid = await sess.open()
        except Exception as exc:  # noqa: BLE001
            self.send({"type": "collab_error", "message": f"editor agent: {exc}"})
            return None
        self.sessions[sid] = sess
        self._locks[sid] = asyncio.Lock()
        self.editor_agents[sid] = {"file": file_path, "primed": False}
        self._editor_by_file[real] = sid
        return sid

    async def editor_agent_prompt(self, session_id: str, text: str, sender: str = None) -> None:
        """Prompt the editor agent; on the FIRST turn prime it with the file it owns."""
        ea = self.editor_agents.get(session_id)
        if ea is None:
            return
        if not ea["primed"]:
            ea["primed"] = True
            name = os.path.basename(ea["file"])
            text = (f"You are helping edit the Markdown file `{name}` in your working "
                    f"directory. When I ask for changes, edit that file directly with your "
                    f"file tools and keep it valid Markdown. Keep chat replies short.\n\n{text}")
        await self.prompt(session_id, text, sender=sender)

    async def close_editor_agent(self, session_id: str) -> None:
        """No-op: the editor agent is SHARED per file and part of the workspace session,
        so closing one user's modal must not tear it down for others. It lives until the
        Collab session stops (``close()`` closes every session, editor agents included)."""
        return None

    # ── collaborative doc editing (Yjs relayed over the shared socket) ─────────
    # The server is a dumb relay: it never merges CRDT state, it just keeps a per-file
    # replay LOG of opaque Yjs update blobs so a late joiner can catch up. Actual
    # merging happens in every browser's Y.Doc. Kept off the run's event_log (these
    # are file-scoped + high-volume) — broadcast happens via hub.send in server.py.
    def doc_join(self, file: str):
        """Return (existed, updates) for a joining client. ``existed`` is False for the
        very FIRST joiner, which then seeds the doc from disk; others sync from the log."""
        existed = file in self._doc_seen
        self._doc_seen.add(file)
        return existed, list(self._doc_logs.get(file, []))

    def doc_append(self, file: str, update_b64: str) -> None:
        """Append a Yjs update to the file's replay log (for future joiners)."""
        self._doc_logs.setdefault(file, []).append(update_b64)

    def doc_replace_state(self, file: str, state_b64: str) -> None:
        """Compaction: replace the log with one encoded full-state blob so join
        payloads stay bounded as edits accumulate."""
        self._doc_seen.add(file)
        self._doc_logs[file] = [state_b64]

    def cancel(self, session_id: str) -> None:
        """Interrupt one session's current agent turn."""
        sess = self.sessions.get(session_id)
        if sess is not None:
            sess.cancel()

    async def remove_session(self, session_id: str) -> None:
        """Close and drop one session/panel."""
        # If this sub still owes a delegating agent a result, hand back what it has
        # so the caller's turn isn't left waiting forever.
        d = self._delegations.pop(session_id, None)
        if d is not None and not d["release"].done():
            sess = self.sessions.get(session_id)
            d["release"].set_result(sess.transcript.assistant_text() if sess else "(sub-agent removed)")
        self.mirrors.pop(session_id, None)       # a read-only mirror (no real session)
        self._takeovers.pop(session_id, None)
        self.annotations.pop(session_id, None)
        self.prompt_items.pop(session_id, None)
        sess = self.sessions.pop(session_id, None)
        self.acp_sessions.pop(session_id, None)
        self._locks.pop(session_id, None)
        self._depth.pop(session_id, None)
        self._parent.pop(session_id, None)
        if sess is not None:
            await sess.close()
        self.send({"type": "collab_session_removed", "session_id": session_id})

    async def fork_session(self, from_session_id: str, seed_prompt: str = None,
                           sender: str = None):
        """Fork a session into a new panel, kicked off with ``seed_prompt`` (e.g.
        the whole final output + a highlighted snippet + 'what to fix').

        GENUINE fork when the source supports it (SdkSession, once it has run a
        turn): the new session resumes the source's real transcript — full context
        (messages, tool calls, thinking) — so the seed lands as the first new turn
        on top of it, and the source is untouched. SNAPSHOT fork otherwise (ACP /
        stub / a not-yet-run SDK session): a fresh session seeded with a paste of
        the source's assistant text prepended to the kickoff."""
        src = self.sessions.get(from_session_id)
        fork_ref = src.fork_ref() if (src is not None and hasattr(src, "fork_ref")) else None
        kickoff = seed_prompt or "Continue from the previous session."
        if fork_ref:
            sid = await self.add_session(fork_ref=fork_ref)  # genuine: context lives in the model
        else:
            context = src.transcript.assistant_text() if src is not None else ""
            sid = await self.add_session()
            if context:
                kickoff = f"Context from a previous session:\n\n{context}\n\n{kickoff}"
        if sid is None:
            return None
        self.send({"type": "collab_session_forked", "session_id": sid, "from": from_session_id,
                   "genuine": bool(fork_ref)})
        await self.prompt(sid, kickoff, sender=sender)
        return sid
