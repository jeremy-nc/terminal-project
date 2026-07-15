import React, { useEffect, useRef, useState } from "react";
import { sendCollabCommand } from "../terminalController.js";

/** [collab-command] Floating, draggable command control for a Collab workspace.
 *  Two states: a small draggable PUCK (closed) and a command PILL (open) with an
 *  inline status line (spinner → fading confirmation). Personal + local: its
 *  position/open-state live in this window only. Rendered only while a session runs. */
const THRESHOLD = 4;   // px of movement before a press counts as a drag (not a click)

export default function CollabCommandPuck({ workspaceId, commandStatus }) {
  const [mode, setMode] = useState("closed");   // closed | open
  const [text, setText] = useState("");
  const [pos, setPos] = useState(() => {
    try { const s = localStorage.getItem(`collab-cmd-pos-${workspaceId}`); if (s) return JSON.parse(s); } catch (_) { /* default */ }
    return { x: 20, y: 20 };
  });
  const rootRef = useRef(null);
  const drag = useRef(null);
  const inputRef = useRef(null);

  // Inline status: spinner while running; the confirmation/error fades after a beat.
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!commandStatus) return undefined;
    setStatus(commandStatus);
    if (commandStatus.state === "running") return undefined;
    const t = setTimeout(() => setStatus(null), 4500);
    return () => clearTimeout(t);
  }, [commandStatus?.at]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (mode === "open") inputRef.current?.focus(); }, [mode]);

  const clamp = (x, y) => {
    const el = rootRef.current, parent = el?.offsetParent;
    if (!parent) return { x, y };
    return {
      x: Math.max(0, Math.min(x, parent.clientWidth - el.offsetWidth)),
      y: Math.max(0, Math.min(y, parent.clientHeight - el.offsetHeight)),
    };
  };

  // Drag from the puck, OR from the open pill's frame/edges. In the open pill, ignore
  // presses on the input / action buttons so typing + clicking still work; every other
  // pixel of the widget is a drag handle. A press without movement (when closed) opens.
  const onPointerDown = (e) => {
    if (e.target.closest && e.target.closest(".collab-cmd-input, .collab-cmd-send")) return;
    e.preventDefault();
    const wasClosed = mode === "closed";
    drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false, last: null };
    const onMove = (ev) => {
      const d = drag.current; if (!d) return;
      const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > THRESHOLD) d.moved = true;
      d.last = clamp(d.ox + dx, d.oy + dy);
      setPos(d.last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const d = drag.current; drag.current = null;
      if (!d) return;
      if (!d.moved) { if (wasClosed) setMode("open"); }
      else if (d.last) { try { localStorage.setItem(`collab-cmd-pos-${workspaceId}`, JSON.stringify(d.last)); } catch (_) { /* ignore */ } }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Collapse back to the puck when focus/click leaves the widget.
  useEffect(() => {
    if (mode !== "open") return undefined;
    const onAway = (e) => { if (!e.target.closest || !e.target.closest(".collab-cmd")) setMode("closed"); };
    document.addEventListener("pointerdown", onAway);
    return () => document.removeEventListener("pointerdown", onAway);
  }, [mode]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    sendCollabCommand(workspaceId, t);
    setText("");
  };

  const style = { left: pos.x, top: pos.y };
  if (mode === "closed") {
    return (
      <div ref={rootRef} className="collab-cmd puck" style={style} onPointerDown={onPointerDown}
           title="Command the workspace — click to open, drag to move">
        <span className="collab-cmd-dot" />
      </div>
    );
  }
  return (
    <div ref={rootRef} className="collab-cmd open" style={style} onPointerDown={onPointerDown}>
      <div className="collab-cmd-pill">
        <input ref={inputRef} className="collab-cmd-input" value={text}
               placeholder="Command the workspace…"
               onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="collab-cmd-send" onClick={send} title="Send (⏎)"><span className="collab-cmd-senddot" /></button>
      </div>
      {status && (
        <div className={`collab-cmd-status ${status.state}`}>
          {status.state === "running"
            ? (<><span className="collab-cmd-spin" />working…</>)
            : status.state === "error" ? `⚠ ${status.text || "failed"}` : `✓ ${status.text || "done"}`}
        </div>
      )}
    </div>
  );
}
