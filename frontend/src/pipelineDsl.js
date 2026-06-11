/**
 * pipelineDsl.js
 *
 * Simple line-based DSL parser for terminal pipelines.
 * Each line is a stage in a sequence.
 * - 'dir: @~/path'         -> global working directory default for the whole pipeline
 * - 'seq: command'         -> TerminalNode (also bare 'command' with no prefix)
 * - 'batch: cmd1, cmd2'    -> BatchNode
 *
 * Per-command working directory:
 *   Append a trailing @<path> token (space-separated, unquoted) to any command.
 *   Paths with spaces must be quoted: cmd @"~/my project"
 *   Precedence: command @path > global dir: > server cwd (repo root).
 */

export function parseDsl(text) {
  // Keep raw lines (with indentation) so the agent block form can be detected.
  const rawLines = text.split("\n");
  const nodes = [];
  let globalCwd = null;

  // Stable, path-independent ids so the live view can map status/session events
  // (which echo node_id back from the server) onto the same spec tree.
  let _seq = 0;
  const nextId = () => `n${_seq++}`;

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i].trim();
    i++;
    if (!line || line.startsWith("#")) continue;

    // dir: @~/path  OR  dir: ~/path  (global working directory)
    if (line.startsWith("dir:")) {
      const raw = line.slice(4).trim();
      globalCwd = raw.startsWith("@") ? raw.slice(1) : raw;
      continue;
    }

    // agent: <prompt>            -> inline Agent (coordinator), backend claude
    // agent: claude -m opus "…"  -> inline, lead with a backend to pass flags
    // agent:                     -> block form with indented system:/prompt:/model:
    if (line.startsWith("agent:")) {
      const inline = line.slice(6).trim();
      if (inline) {
        nodes.push(_parseAgentInline(inline, nextId()));
      } else {
        const { block, next } = _parseAgentBlock(rawLines, i);
        i = next;
        nodes.push({
          id: nextId(),
          type: "agent",
          backend: "claude",
          model: block.model || null,
          system: block.system || null,
          // kickoff defaults to the upstream output ({{input}}), like every node
          prompt: block.prompt != null ? block.prompt : "{{input}}",
          mcps: [],
          delegate: true,
        });
      }
      continue;
    }

    // dyn_batch: cmd            -> fan out one terminal per item, list derived
    //                              at runtime (LLM-structured if not already a list)
    // dyn_batch(N): cmd         -> N identical terminals (best-of-N), no LLM
    if (line.startsWith("dyn_batch")) {
      const match = line.match(/^dyn_batch(?:\((\d+)\))?:\s*(.*)$/);
      if (match) {
        const count = match[1] ? parseInt(match[1]) : null;
        const { argv, cwd } = _parseCommand(match[2]);
        const node = count != null
          ? { id: nextId(), type: "fanout", argv, count }
          : { id: nextId(), type: "dynamic_batch", argv };
        if (cwd !== null) node.cwd = cwd;
        nodes.push(node);
      }
      continue;
    }

    if (line.startsWith("batch:") || line.startsWith("batch(")) {
      // batch(N): cmd1, cmd2...
      const match = line.match(/^batch(?:\((\d+)\))?:\s*(.*)$/);
      if (match) {
        const concurrency = match[1] ? parseInt(match[1]) : null;
        const cmds = _splitCommands(match[2]);
        nodes.push({
          id: nextId(),
          type: "batch",
          concurrency,
          nodes: cmds.map(c => {
            const { argv, cwd } = _parseCommand(c);
            const node = { id: nextId(), type: "terminal", argv };
            if (cwd !== null) node.cwd = cwd;
            return node;
          })
        });
      }
    } else {
      // seq: cmd OR just cmd
      const cmdText = line.startsWith("seq:") ? line.slice(4).trim() : line;
      const { argv, cwd } = _parseCommand(cmdText);
      const node = { id: nextId(), type: "terminal", argv };
      if (cwd !== null) node.cwd = cwd;
      nodes.push(node);
    }
  }

  const root = { id: "root", type: "sequence", nodes };
  if (globalCwd !== null) root.cwd = globalCwd;
  return root;
}

/** Inline agent form: `<prompt>` or `claude -m opus "<prompt>"`. */
function _parseAgentInline(inline, id) {
  const KNOWN_BACKENDS = ["claude", "auggie"];
  const tokens = _tokenize(inline);
  let backend = "claude";
  let model = null;
  let prompt;
  if (tokens.length && KNOWN_BACKENDS.includes(tokens[0])) {
    backend = tokens[0];
    const promptParts = [];
    for (let j = 1; j < tokens.length; j++) {
      if ((tokens[j] === "-m" || tokens[j] === "--model") && j + 1 < tokens.length) {
        model = tokens[++j];
      } else {
        promptParts.push(tokens[j]);
      }
    }
    prompt = promptParts.join(" ");
  } else {
    prompt = tokens.join(" ");
  }
  return { id, type: "agent", backend, model, prompt, system: null, mcps: [], delegate: true };
}

/**
 * Indented agent block: `key: value` lines, plus `key: |` multi-line scalars
 * (YAML-ish). Returns the parsed fields and the index where the block ended.
 *   agent:
 *     system: |
 *       You are a triager…
 *     prompt: {{input}}
 */
function _parseAgentBlock(rawLines, i) {
  const block = {};
  while (i < rawLines.length) {
    const raw = rawLines[i];
    if (!raw.trim()) { i++; continue; }            // blank line inside the block
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break;                        // dedent -> block ends
    const m = raw.trim().match(/^(\w+):\s*(.*)$/);
    i++;
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val === "|") {
      // multi-line scalar: gather lines indented deeper than this key
      const buf = [];
      while (i < rawLines.length) {
        const ml = rawLines[i];
        if (!ml.trim()) { buf.push(""); i++; continue; }
        const mIndent = ml.length - ml.trimStart().length;
        if (mIndent <= indent) break;
        buf.push(ml);
        i++;
      }
      const content = buf.filter(l => l.trim());
      const strip = content.length
        ? Math.min(...content.map(l => l.length - l.trimStart().length))
        : 0;
      val = buf.map(l => l.slice(strip)).join("\n").replace(/\s+$/, "");
    }
    block[key] = val;
  }
  return { block, next: i };
}

/** 
 * Splits comma-separated commands, respecting quoted strings.
 * e.g. 'echo "a, b", ls' -> ['echo "a, b"', 'ls']
 */
function _splitCommands(text) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') inQuotes = !inQuotes;
    if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

/**
 * Parse a raw command string into { argv, cwd }.
 * If the last whitespace-separated token starts with '@', it is the cwd;
 * everything before it is the command.  Quoted paths (@"...") are supported.
 */
function _parseCommand(cmd) {
  const tokens = _tokenize(cmd);
  if (tokens.length > 0 && tokens[tokens.length - 1].startsWith("@")) {
    const cwd = tokens[tokens.length - 1].slice(1); // strip leading '@'
    const argv = tokens.slice(0, -1);
    return { argv, cwd: cwd || null };
  }
  return { argv: tokens, cwd: null };
}

/**
 * Basic shell tokenizer: splits by space but respects single and double quotes.
 * Quotes are stripped from the resulting tokens.
 */
function _tokenize(cmd) {
  const tokens = [];
  let current = "";
  let quote = null; // null | '"' | "'"
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote !== null && char === quote) {
      quote = null;
      continue;
    }
    if (char === ' ' && quote === null) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}
