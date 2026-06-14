import React from "react";
import { openInTerminal } from "../terminalController.js";

/**
 * Button that hands a session off to the real macOS Terminal. Renders nothing
 * until the session exists (sessionId set). Backend decides the semantics:
 * a true tmux re-attach, or a fresh shell at the session's working directory.
 */
export default function OpenInTerminalButton({ sessionId, className = "", label = "" }) {
  if (!sessionId) return null;
  return (
    <button
      className={`open-in-terminal ${className}`}
      title="Open in macOS Terminal"
      onClick={(e) => { e.stopPropagation(); openInTerminal(sessionId); }}
    >
      <span className="oit-icon">⤢</span>
      {label && <span className="oit-label">{label}</span>}
    </button>
  );
}
