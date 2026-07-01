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

    // itr(N): <indented block>  -> IterationNode. Loops the body (seq/batch/…
    //   lines) feeding each pass's output back as the next pass's input, until a
    //   hidden judge says complete or N passes run (default 5). An `until:` line
    //   gives the judge a plain-language criterion; omit it to let it self-assess.
    if (line.startsWith("itr:") || line.startsWith("itr(")) {
      const m = line.match(/^itr(?:\((\d+)\))?:\s*(.*)$/);
      if (m) {
        const maxIter = m[1] ? parseInt(m[1]) : 5;
        const itrId = nextId();
        const bodyId = nextId();
        const { bodyNodes, until, next } = _parseItrBlock(rawLines, i, nextId);
        i = next;
        const node = {
          id: itrId,
          type: "iteration",
          max_iterations: maxIter,
          body: { id: bodyId, type: "sequence", nodes: bodyNodes },
        };
        if (until != null) node.until = until;
        nodes.push(node);
      }
      continue;
    }

    // dyn_batch / batch / seq / bare command -> a single node
    const node = _parseNodeLine(line, nextId);
    if (node) nodes.push(node);
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
 * Parse a single non-block line into one node: `dyn_batch(N): …`, `batch(N): …`,
 * `seq: …`, or a bare command. Shared by the top-level loop and the itr body so
 * the same forms work inside `itr:`.
 */
function _parseNodeLine(line, nextId) {
  if (line.startsWith("dyn_batch")) {
    const match = line.match(/^dyn_batch(?:\((\d+)\))?:\s*(.*)$/);
    if (!match) return null;
    const count = match[1] ? parseInt(match[1]) : null;
    const { argv, cwd } = _parseCommand(match[2]);
    const node = count != null
      ? { id: nextId(), type: "fanout", argv, count }
      : { id: nextId(), type: "dynamic_batch", argv };
    if (cwd !== null) node.cwd = cwd;
    return node;
  }
  if (line.startsWith("batch:") || line.startsWith("batch(")) {
    const match = line.match(/^batch(?:\((\d+)\))?:\s*(.*)$/);
    if (!match) return null;
    const concurrency = match[1] ? parseInt(match[1]) : null;
    const cmds = _splitCommands(match[2]);
    return {
      id: nextId(),
      type: "batch",
      concurrency,
      nodes: cmds.map(c => {
        const { argv, cwd } = _parseCommand(c);
        const n = { id: nextId(), type: "terminal", argv };
        if (cwd !== null) n.cwd = cwd;
        return n;
      }),
    };
  }
  // seq: cmd OR just cmd
  const cmdText = line.startsWith("seq:") ? line.slice(4).trim() : line;
  const { argv, cwd } = _parseCommand(cmdText);
  const node = { id: nextId(), type: "terminal", argv };
  if (cwd !== null) node.cwd = cwd;
  return node;
}

/**
 * Indented `itr:` block: collects body node lines (seq/batch/…) in order, plus an
 * optional `until: <criterion>` line (the hidden judge's condition; surrounding
 * quotes stripped). Returns the body nodes, the criterion, and where the block ended.
 */
function _parseItrBlock(rawLines, i, nextId) {
  const bodyNodes = [];
  let until = null;
  while (i < rawLines.length) {
    const raw = rawLines[i];
    if (!raw.trim()) { i++; continue; }            // blank line inside the block
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break;                        // dedent -> block ends
    const line = raw.trim();
    i++;
    if (line.startsWith("#")) continue;
    if (line.startsWith("until:")) {
      let v = line.slice(6).trim();
      if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') ||
                            (v[0] === "'" && v[v.length - 1] === "'"))) {
        v = v.slice(1, -1);
      }
      until = v || null;
      continue;
    }
    const node = _parseNodeLine(line, nextId);
    if (node) bodyNodes.push(node);
  }
  return { bodyNodes, until, next: i };
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
 *
 * A command WRAPPED IN OUTER QUOTES ("…" or '…') is run through a login shell —
 * `zsh -lc "…"` — so `~`, `$vars`, globs, pipes and escaped spaces all work like a
 * normal terminal (an optional trailing ` @cwd` still sets the working dir). An
 * UNQUOTED command is tokenised and exec'd directly (backwards-compatible), with a
 * trailing `@` token as the cwd. Quoting only the first arg (`"my prog" a b`) falls
 * through to the direct path.
 */
function _parseCommand(cmd) {
  const t = cmd.trim();
  const q = t[0];
  if (q === '"' || q === "'") {
    const end = t.indexOf(q, 1);
    if (end > 0) {
      const after = t.slice(end + 1).trim();
      if (after === "" || after.startsWith("@")) {          // whole command is wrapped → shell it
        const inner = t.slice(1, end);
        const cwd = after.startsWith("@") ? (after.slice(1).replace(/^["']|["']$/g, "") || null) : null;
        return { argv: ["/bin/zsh", "-lc", inner], cwd };
      }
    }
  }
  const tokens = _tokenize(cmd);
  if (tokens.length > 0 && tokens[tokens.length - 1].startsWith("@")) {
    const cwd = tokens[tokens.length - 1].slice(1); // strip leading '@'
    return { argv: tokens.slice(0, -1), cwd: cwd || null };
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
