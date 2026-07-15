"""[collab-command] Natural-language control plane for a Collab workspace.

Fully ADDITIVE and removable. This module only CONSUMES CollabRun's public API
(add_session / prompt / remove_session / …) and emits events via ``run.send`` — it
never touches CollabRun internals nor changes any existing behaviour. A cheap Haiku
agent turns a user's plain-language request into tool calls that either drive the
workspace's agents (shared, authoritative) or the issuer's UI (targeted intents).

To remove the feature entirely, delete this file and the ``[collab-command]`` marked
lines in agents/collab/run.py, agents/sdk/session.py and server.py, plus the frontend
command puck + ``collab_ui_intent`` / ``collab_command_ack`` handlers.
"""
import asyncio
import os

from agents.sdk.session import _sdk

CONTROL_MODEL = "claude-haiku-4-5"   # cheap router
# The router is a PURE ROUTER: it must ONLY call its own collab_control tools (and emit
# text), never do the work itself. So disallow EVERY built-in — reads, search, web, shell,
# edits, todos — leaving only the mcp__collab_control__* tools available.
CONTROL_DISALLOWED = [
    "Task", "Agent", "Workflow", "RemoteTrigger", "SlashCommand",
    "Bash", "BashOutput", "KillShell", "KillBash",
    "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead",
    "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite",
]

# The router's SYSTEM prompt (replaces the big claude_code preset → far fewer tokens/turn).
SYSTEM_PROMPT = (
    "You are ONLY a command ROUTER for a shared 'Collab' agent workspace — you never do the "
    "work yourself. Do NOT research, read files, browse the web, write content, or answer the "
    "substantive request. Your ONLY job is to translate the user's request into control-tool "
    "calls that make the workspace's AGENTS do the work (launch_agent / prompt_agent) or that "
    "drive the UI (open a file, focus a panel). If a request needs work done, LAUNCH or PROMPT "
    "an agent — never attempt it yourself. Be FAST: make the FEWEST tool calls (ideally ONE) "
    "and act immediately. Agents are referenced by the short id shown to the user (e.g. "
    "'51c9a5'). Call list_agents ONLY when you must target an EXISTING agent (stop/prompt/"
    "focus) and don't already know its id — NEVER before launch_agent or open_file_in_editor. "
    "When you launch agents, give each a clear, self-contained kickoff prompt. To open a file "
    "for editing, call open_file_in_editor with the file NAME directly (do NOT call find_file "
    "first). Finish with ONE short line confirming what you did."
)


def _find_docs(run, name):
    """FAST, scoped file lookup for the editor: only the workspace's docs/specs folders
    (small) + the top level — NOT a full recursive walk of a possibly-huge workspace dir
    like ~/Code. Matches where the DocsExplorer/editor actually sources files."""
    name = (name or "").strip().lower()
    if not name:
        return []
    root = run.cwd or "."
    hits = []
    for base in (os.path.join(root, "specs"), os.path.join(root, "docs")):
        if not os.path.isdir(base):
            continue
        for dp, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                if name == f.lower() or name in f.lower():
                    hits.append(os.path.join(dp, f))
            if len(hits) >= 20:
                return hits[:20]
    try:  # shallow: the workspace root itself
        for f in os.listdir(root):
            if (name == f.lower() or name in f.lower()) and os.path.isfile(os.path.join(root, f)):
                hits.append(os.path.join(root, f))
    except OSError:
        pass
    return hits[:20]


def _resolve(run, id_str):
    """Resolve an agent reference to a full session id. Accepts the full id, the 6-char
    short id shown in the UI (e.g. '51c9a5'), or any unique prefix. None if 0/2+ match."""
    s = (id_str or "").strip()
    if not s:
        return None
    if s in run.sessions:
        return s
    matches = [sid for sid in run.sessions if sid != run._command and sid.startswith(s)]
    return matches[0] if len(matches) == 1 else None


def make_control_server(run):
    """Build the in-process MCP server of control tools bound to ``run``. Every tool is
    a thin wrapper over an existing CollabRun method or a UI-intent broadcast."""
    if _sdk is None:
        return None

    def _ok(text):
        return {"content": [{"type": "text", "text": text or "(done)"}]}

    @_sdk.tool("list_agents",
               "List this workspace's agent panels with a short summary of each (id + "
               "most recent output) so you can pick the right one.", {})
    async def _list_agents(args):
        out = []
        for sid, sess in list(run.sessions.items()):
            if sid in run._command_sids:     # hide the router session(s) themselves
                continue
            try:
                recent = (sess.transcript.assistant_text() or "").strip().replace("\n", " ")
            except Exception:                # noqa: BLE001
                recent = ""
            out.append(f"- {sid[:6]} — {recent[:180] or '(no output yet)'}")   # short id = what the user sees
        return _ok("\n".join(out) or "(no agents running)")

    @_sdk.tool("launch_agent",
               "Launch a NEW agent panel and start it working on `prompt`. Returns "
               "immediately with the new agent's id — the agent then works in its own "
               "panel (approve any tool prompts there).", {"prompt": str})
    async def _launch_agent(args):
        sid = await run.add_session()                       # open the panel (fast — no turn awaited)
        if not sid:
            return _ok("launch failed")
        prompt = (args.get("prompt") or "").strip()
        if prompt:
            asyncio.create_task(run.prompt(sid, prompt))    # fire the kickoff in the background
        return _ok(f"launched agent {sid[:6]}")

    @_sdk.tool("prompt_agent", "Send a follow-up prompt to an existing agent (id from list_agents).",
               {"id": str, "text": str})
    async def _prompt_agent(args):
        sid = _resolve(run, args.get("id", ""))
        if not sid:
            return _ok(f"no agent matches '{args.get('id', '')}' — call list_agents")
        await run.prompt(sid, args.get("text", ""))
        return _ok(f"prompted {sid[:6]}")

    @_sdk.tool("stop_agent", "Stop and close (remove) an agent panel (id from list_agents).", {"id": str})
    async def _stop_agent(args):
        sid = _resolve(run, args.get("id", ""))
        if not sid:
            return _ok(f"no agent matches '{args.get('id', '')}' — call list_agents")
        await run.remove_session(sid)
        return _ok(f"stopped {sid[:6]}")

    @_sdk.tool("find_file",
               "List full path(s) for a markdown file name in the workspace docs.", {"name": str})
    async def _find_file(args):
        hits = _find_docs(run, args.get("name", ""))
        return _ok("\n".join(hits) if hits else "(no match)")

    @_sdk.tool("open_file_in_editor",
               "Open a markdown file in the editor FOR THE USER — pass the file NAME "
               "directly (e.g. 'TEMPLATE.md'); it's resolved automatically. No need to "
               "call find_file first.", {"file": str})
    async def _open_file(args):
        ref = (args.get("file") or args.get("path") or "").strip()
        path = ref if os.path.isfile(ref) else next(iter(_find_docs(run, ref)), None)
        if not path:
            return _ok(f"no file matches '{ref}'")
        run._emit_ui_intent("open_editor", path=path)
        return _ok(f"opening {os.path.basename(path)}")

    @_sdk.tool("focus_agent", "Bring an agent panel into view FOR THE USER (id from list_agents).", {"id": str})
    async def _focus_agent(args):
        sid = _resolve(run, args.get("id", ""))
        if not sid:
            return _ok(f"no agent matches '{args.get('id', '')}' — call list_agents")
        run._emit_ui_intent("focus_agent", session_id=sid)
        return _ok(f"focused {sid[:6]}")

    return _sdk.create_sdk_mcp_server("collab_control", tools=[
        _list_agents, _launch_agent, _prompt_agent, _stop_agent,
        _find_file, _open_file, _focus_agent,
    ])
