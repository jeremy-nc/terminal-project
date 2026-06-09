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
  const lines = text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const nodes = [];
  let globalCwd = null;

  // Stable, path-independent ids so the live view can map status/session events
  // (which echo node_id back from the server) onto the same spec tree.
  let _seq = 0;
  const nextId = () => `n${_seq++}`;

  for (const line of lines) {
    // dir: @~/path  OR  dir: ~/path  (global working directory)
    if (line.startsWith("dir:")) {
      const raw = line.slice(4).trim();
      globalCwd = raw.startsWith("@") ? raw.slice(1) : raw;
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
