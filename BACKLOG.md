# Terminal Project Backlog

## Recently Completed
- **Hierarchical Live View**: Replaced flat list with recursive tree rendering that mirrors the pipeline preview (parallel batches side-by-side, sequences stacked).
- **Node ID Propagation**: Added stable IDs (`n0`, `n1`, etc.) to DSL parser and backend events to correctly route terminal sessions to UI slots.
- **Result Decoding**: Implemented Base64 decoding for final pipeline output in the dashboard.
- **UI Overflow Fixes**: Added CSS to ensure the result panel wraps text and handles long outputs with scrollbars.
- **Auggie Integration**: Standardized default pipeline node to use `auggie --print -m prism-a --mcp-config '{}'`.
- **Process Cleanup**: Hardened process management to ensure stray child processes are killed between runs.

## Future / Open Items

### AgentCoordinator Node (new node type)
A first-class pipeline node type specialised for AI agents, sitting alongside `seq:` and `batch:`.

**Concept:**
- DSL keyword: `agent:` (or `coordinator:`)
- Supported backends: `auggie` and `claude` (Claude CLI)
- Encapsulates agent-specific config as structured fields rather than raw shell args:
  - `model:` — e.g. `prism-a`, `claude-3-5-sonnet`
  - `prompt:` — the instruction text (avoids quoting/escaping issues in the DSL)
  - `mcps:` — named list of allowed MCP servers, or empty for none
  - `tools:` — optional explicit tool allowlist
  - `output_format:` — e.g. `text`, `json`
- The coordinator node translates these fields into the correct CLI invocation for the chosen backend.
- In the live view, agent nodes get a distinct card style (e.g. coloured border, agent icon) to visually distinguish them from plain terminal nodes.
- Output from the agent is decoded and piped into the next node in the sequence as `{{input}}` like any other node.

**Example DSL:**
```
agent: auggie
  model: prism-a
  mcps: []
  prompt: Summarise the following report
batch: claude, bash -c "echo fallback"
seq: bash -c "echo Final: {{input}}"
```

**Open questions:**
- Should the agent node support `--dangerously-skip-permissions` or similar flags as a named option?
- Should streaming agent output appear live in the terminal card, or only on completion?
- Multi-turn / interactive agent support (needs_input flow)?


### Markdown Editor with Session-Scoped Refinement
A markdown editing surface where each document is tied to a Claude session, so
the user can iteratively refine specific sections by selecting text and
instructing the LLM.

**Concept:**
- A markdown editor (with live preview) where each `.md` file is associated
  with a persistent Claude session id — edits accrue context across a working
  session rather than being one-shot prompts.
- Select a passage and issue an instruction (e.g. "we just want to refine this
  section", "tighten this", "make this more formal"); only the selected range
  is sent for refinement and the returned text replaces the selection.
- The session id lets the model carry document context/history between
  refinements (consistent voice, prior decisions) without re-sending the whole
  document each time.

**Data model:**
- Use a small SQL database (e.g. SQLite) for the associated data rather than
  ad-hoc files — the current PTY sessions are ephemeral/in-memory only:
  - `documents` — file path/id, title, current session id, timestamps.
  - `sessions` — Claude session id ↔ document, model, created/last-used.
  - `revisions` — per-refinement history (selection range, instruction,
    before/after text) for undo + audit.

**Example flow:**
1. Open `notes.md` → editor loads it and looks up (or creates) its associated
   session id in SQL.
2. User selects a paragraph and types "we just want to refine this section".
3. Backend sends only that selection (+ session context) to the model; the
   reply replaces the selection; a `revisions` row is recorded.

**Open questions:**
- Section granularity: refine the raw selection, or snap to the enclosing
  markdown block (heading / list / paragraph)?
- Apply mode: replace in place, or show a diff with accept/reject before
  committing?
- Where does refinement run — a headless `claude -p` session (like the
  structurer) or a direct API call (the `Structurer`-style adapter)?
- Conflict handling if the file changes on disk outside the editor.


- [ ] Add ability to cancel individual nodes from the UI.
- [ ] Implement multi-session support (multiple active pipelines).
- [ ] Persistent pipeline history in the sidebar.
- [ ] Support for more complex DSL structures (nested batches/sequences).
- [ ] Advanced terminal features (search, clear buffer).
- [ ] Dark/Light mode toggle persistence.
