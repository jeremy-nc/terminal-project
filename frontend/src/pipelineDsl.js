/**
 * pipelineDsl.js
 * 
 * Simple line-based DSL parser for terminal pipelines.
 * Each line is a stage in a sequence.
 * - 'seq: command' or just 'command' -> TerminalNode
 * - 'batch: cmd1, cmd2' -> BatchNode
 */

export function parseDsl(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const nodes = [];

  // Stable, path-independent ids so the live view can map status/session events
  // (which echo node_id back from the server) onto the same spec tree.
  let _seq = 0;
  const nextId = () => `n${_seq++}`;

  for (const line of lines) {
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
          nodes: cmds.map(c => ({ id: nextId(), type: "terminal", argv: _tokenize(c) }))
        });
      }
    } else {
      // seq: cmd OR just cmd
      const cmdText = line.startsWith("seq:") ? line.slice(4).trim() : line;
      nodes.push({
        id: nextId(),
        type: "terminal",
        argv: _tokenize(cmdText)
      });
    }
  }

  return { id: "root", type: "sequence", nodes };
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
 * Basic shell tokenizer: splits by space but respects quotes.
 */
function _tokenize(cmd) {
  const tokens = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ' ' && !inQuotes) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}
