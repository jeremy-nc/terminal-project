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

from agents.acp import AcpPool, AcpSession


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
        for sess in list(self.sessions.values()):
            try:
                await sess.close()
            except Exception:  # noqa: BLE001 — best-effort teardown
                pass
        self.sessions.clear()
        try:
            await self.acp.close()  # kill the agent subprocess
        except Exception:  # noqa: BLE001
            pass

    # ── sessions (panels) ─────────────────────────────────────────────────────
    async def _ensure_client(self):
        if self._client is None:
            self._client = await self.acp.get(self.agent, self.cwd)
        return self._client

    async def add_session(self, kickoff: str = None):
        """Open a new session/panel on the shared agent client."""
        try:
            client = await self._ensure_client()
            sess = AcpSession(client, self.cwd, key=None, key_field="session_id",
                              emit=self.send, perms=self.acp_perms, permission="ask",
                              agent=self.agent)
            sid = await sess.open(mcps=[])
            self.sessions[sid] = sess
            self._locks[sid] = asyncio.Lock()
            self.acp_sessions[sid] = (client, sid)
            self.send({"type": "collab_session_added", "session_id": sid, "agent": self.agent})
            if kickoff:
                await self.prompt(sid, kickoff, sender=None)
            return sid
        except Exception as exc:  # noqa: BLE001 — surface spawn/session failures
            self.send({"type": "collab_error", "message": str(exc)})
            return None

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

    def chat(self, session_id: str, text: str, sender: str) -> None:
        """A broadcast-only chat message (not sent to the agent)."""
        sess = self.sessions.get(session_id)
        if sess is not None:
            sess.record_chat(sender, text)

    def cancel(self, session_id: str) -> None:
        """Interrupt one session's current agent turn."""
        sess = self.sessions.get(session_id)
        if sess is not None:
            sess.cancel()

    async def remove_session(self, session_id: str) -> None:
        """Close and drop one session/panel."""
        sess = self.sessions.pop(session_id, None)
        self.acp_sessions.pop(session_id, None)
        self._locks.pop(session_id, None)
        if sess is not None:
            await sess.close()
        self.send({"type": "collab_session_removed", "session_id": session_id})

    async def fork_session(self, from_session_id: str, seed_prompt: str = None,
                           sender: str = None):
        """Snapshot fork: a new session/panel seeded with a copy of the source's
        conversation, then kicked off with ``seed_prompt`` (e.g. the whole final
        output + a highlighted snippet + 'what to fix')."""
        src = self.sessions.get(from_session_id)
        context = src.transcript.assistant_text() if src is not None else ""
        sid = await self.add_session()
        if sid is None:
            return None
        kickoff = seed_prompt or "Continue from the previous session."
        if context:
            kickoff = f"Context from a previous session:\n\n{context}\n\n{kickoff}"
        self.send({"type": "collab_session_forked", "session_id": sid, "from": from_session_id})
        await self.prompt(sid, kickoff, sender=sender)
        return sid
