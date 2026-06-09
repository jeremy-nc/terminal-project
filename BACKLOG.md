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


- [ ] Add ability to cancel individual nodes from the UI.
- [ ] Implement multi-session support (multiple active pipelines).
- [ ] Persistent pipeline history in the sidebar.
- [ ] Support for more complex DSL structures (nested batches/sequences).
- [ ] Advanced terminal features (search, clear buffer).
- [ ] Dark/Light mode toggle persistence.
