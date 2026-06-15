import React, { useState } from "react";
import { copyShareLink } from "../terminalController.js";

/** Copies a shareable deep-link to this node's live terminal to the clipboard. */
export default function CopyLinkButton({ workspaceId, nodeId, className = "" }) {
  const [copied, setCopied] = useState(false);
  if (!workspaceId || nodeId == null) return null;
  return (
    <button
      className={`copy-link ${className}`}
      title="Copy shareable link to this node"
      onClick={(e) => {
        e.stopPropagation();
        copyShareLink(workspaceId, nodeId)
          .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })
          .catch(() => {});
      }}
    >
      {copied ? "✓" : "🔗"}
    </button>
  );
}
