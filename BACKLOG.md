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


### Workspace directory → git worktree management
A Workspace already stores (and validates) a `dir`, but it's currently **unused**
at runtime — the pipeline's cwd still comes from the DSL `dir:`. Future: make
`workspace.dir` a **git worktree** so each workspace/session operates on an
isolated checkout of the repo, letting concurrent sessions run in parallel
without stepping on each other's files.

**Concept:**
- On create, optionally `git worktree add <dir> <branch>` (or attach to an
  existing dir); on delete, `git worktree remove`/prune.
- When the workspace runs, its pipeline's global cwd becomes the worktree dir
  (so the `dir` finally "does something").
- Pairs naturally with multi-session: N workspaces = N worktrees = N parallel
  agent sessions on the same repo, isolated.

**Open questions:**
- Auto-create a worktree+branch per workspace, or let the user point at an
  existing directory (worktree or not)?
- Branch naming / lifecycle (delete the branch on workspace delete?).
- Guard against running two workspaces against the *same* dir.


### Agent Skills Browser
Fetch a popular public repo of agent skills and display the available skills in
a browsable list in the UI.

**Source repo (candidate):** [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills)
— "Production-grade engineering skills for AI coding agents" (~59k stars,
default branch `main`). Verified layout: a top-level `skills/` directory holds
~24 skill folders (`api-and-interface-design`, `code-review-and-quality`,
`debugging-and-error-recovery`, …), each containing a `SKILL.md`.

**Concept:**
- Fetch the skill index via the GitHub contents API
  (`/repos/addyosmani/agent-skills/contents/skills`), then read each folder's
  `SKILL.md` and parse its frontmatter (`name`, `description`, etc.).
- Render the skills as a searchable/filterable list (name + one-line
  description, maybe tags) as a new view alongside Pipeline/Terminal.
- Surface enough detail to decide relevance (description, source link) without
  cloning the whole repo.

**Open questions:**
- Pin `addyosmani/agent-skills` as the single source, or make the source repo
  (and branch/path) configurable so other skill collections can be added?
- Fetch live via the GitHub API (unauthenticated = 60 req/hr rate limit; an
  optional token raises it) vs. a cached / periodically-refreshed snapshot.
- Read-only browse only, or also let the user import/install a selected skill
  into the project (and eventually invoke one as a pipeline node)?


- [ ] Add ability to cancel individual nodes from the UI.
- [ ] Implement multi-session support (multiple active pipelines).
- [ ] Stdin-based `{{input}}` passing (shell-injection safety). Today `{{input}}`
      is substituted textually into a node's argv, so a stage like
      `bash -c "echo {{input}}"` lets multi-line agent output be interpreted by
      the shell — e.g. markdown `> line` blockquotes became `>`-redirections and
      created junk files in the working dir. Add a way to feed `{{input}}` to a
      command via **stdin** (written to the process after spawn) so it's treated
      as data, never shell-interpreted. Likely a DSL marker (e.g. `{{stdin}}` or
      a per-node flag) so authors opt in; pairs well with commands that read
      stdin (`cat`, `jq`, an LLM CLI's `-`/prompt-on-stdin mode). Keeps the
      current arg-substitution form for cases that genuinely want it.
- [ ] Fork-PR worktrees ("Work on this" from the PR list). Today `WorktreeKind`
      resolves a branch as: local → checkout, on `origin` → fetch + track
      (the dependabot / same-repo case), neither → new branch off HEAD. A PR
      from a **fork** has its head on another repo, so `origin/<branch>` doesn't
      exist and it falls back to a (wrong) new branch. Fix: when the PR is a
      fork (`github.pulls` already returns `isFork` + the PR `number`), fetch the
      PR head ref instead — `git fetch origin pull/<number>/head` — and create
      the worktree from `FETCH_HEAD` (you can't push back to origin for a fork,
      so it's a read/review worktree). Thread the PR number through the
      `/pipeline/new-workspace` prefill so the worktree adapter knows to use the
      pull-ref path.
- [ ] Persistent pipeline history in the sidebar.
- [ ] Support for more complex DSL structures (nested batches/sequences).
- [ ] Advanced terminal features (search, clear buffer).
- [ ] Dark/Light mode toggle persistence.
- [ ] Agent tree view: render a coordinator and its delegated sub-agents as an
      indented tree with a connector line (Augment-style), and dim/shrink the
      child cards so they clearly read as subordinate. (For now they lay out
      horizontally next to the coordinator like a dyn_batch row.)
- [ ] Sub-coordinator + relay channel (delegate-initiated questions). Today a
      delegated sub-agent is a one-shot `claude -p` that can't ask for input;
      the coordinator mediates all user interaction (delegate → ask_user →
      re-delegate). To let a sub-agent *pause mid-task and ask up the chain*:
      make the delegate a sub-coordinator (SDK loop) with an `ask_coordinator`
      tool, and pass a **relay callback** when spawning it. `ask_coordinator(q)`
      → `await relay(q)` → the parent narrates it and calls its own `ask_user`
      → the human answers in the coordinator's terminal → the answer flows back
      down and the sub-agent resumes. Keeps a single conversational surface (the
      coordinator) while letting sub-agents drive questions into it. Recursive —
      depth-cap it. (Note: a delegate with its *own* `ask_user` would instead
      prompt the user directly as a second surface, which we want to avoid.)
