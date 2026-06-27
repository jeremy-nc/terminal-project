import React, { useEffect, useState, useSyncExternalStore } from "react";
import { subscribe, getSnapshot, watchDocs, unwatchDocs } from "../terminalController.js";

// Which sub-directory of the workspace holds the docs. Today "docs"; this is the one
// place to change it (e.g. to "meta/docs") or to later make it configurable per repo.
export const DOCS_SUBDIR = "docs";

function fmtSize(n) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** One tree node (read-only): a collapsible directory or a file row. */
function TreeNode({ node, depth }) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: 6 + depth * 13 };
  if (node.type === "dir") {
    return (
      <div className="docs-node">
        <div className="docs-row dir" style={pad} onClick={() => setOpen((o) => !o)}>
          <span className="docs-caret">{open ? "▾" : "▸"}</span>
          <span className="docs-ic">📁</span>
          <span className="docs-name">{node.name}</span>
        </div>
        {open && (node.children || []).map((c) => (
          <TreeNode key={c.name} node={c} depth={depth + 1} />
        ))}
      </div>
    );
  }
  return (
    <div className="docs-row file" style={pad} title={node.name}>
      <span className="docs-caret" />
      <span className="docs-ic">📄</span>
      <span className="docs-name">{node.name}</span>
      <span className="docs-size">{fmtSize(node.size)}</span>
    </div>
  );
}

/** Live, read-only file explorer for a workspace's docs folder (``<baseDir>/docs``).
 *  Self-contained like the TeamCity/Repo panels: it ref-counts a watch on the docs
 *  directory (so several panels of the same dir share one backend FS watcher) and
 *  reads that dir's tree from the central store, which the backend refreshes on OS
 *  filesystem events. Renders an empty state when the folder is absent. */
export default function DocsExplorer({ baseDir }) {
  const dir = baseDir ? `${baseDir.replace(/\/+$/, "")}/${DOCS_SUBDIR}` : null;
  const { docsTrees } = useSyncExternalStore(subscribe, getSnapshot);
  const entry = dir ? docsTrees[dir] : undefined;

  useEffect(() => {
    if (!dir) return undefined;
    watchDocs(dir);
    return () => unwatchDocs(dir);
  }, [dir]);

  if (!dir) return null;
  return (
    <div className="docs-explorer">
      <div className="sidebar-header docs-head">
        <span>Docs</span>
        <code className="docs-path" title={dir}>{DOCS_SUBDIR}/</code>
      </div>
      <div className="docs-tree">
        {entry === undefined
          ? <div className="text-faint">Loading…</div>
          : !entry.exists
            ? <div className="text-faint">No {DOCS_SUBDIR}/ folder</div>
            : entry.tree.length === 0
              ? <div className="text-faint">Empty</div>
              : entry.tree.map((n) => <TreeNode key={n.name} node={n} depth={0} />)}
      </div>
    </div>
  );
}
