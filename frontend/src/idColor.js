// Deterministic per-user colour + short label, shared by the agent panels, the
// collaborative-document cursors, and doc annotations so a given user reads the
// same colour/id everywhere.
export function colorForId(id) {
  let h = 0;
  for (let i = 0; i < (id || "").length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 80%, 60%)`;
}

export function short(id) { return (id || "").slice(0, 6); }
