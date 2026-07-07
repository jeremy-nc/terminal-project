import React, { useRef, useLayoutEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Rich live view of an ACP coding-agent node: renders its structured transcript
 * (thoughts, assistant markdown, tool calls with IN/OUT, diffs) built from
 * `acp_update` deltas, plus an inline approval prompt when the agent asks for
 * permission (`acp_permission`). The same `perm` state is what the 3D world will
 * later read to float an approval over the node — this card is just the first
 * surface for it.
 */

/**
 * Keep a scroll container pinned to the bottom as content streams in — but only
 * while the user is already near the bottom. If they scroll up to read, we stop
 * following until they return to the bottom. `dep` should change as content grows.
 */
function useStickToBottom(...deps) {
  const ref = useRef(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, deps);  // eslint-disable-line react-hooks/exhaustive-deps
  return { ref, onScroll };
}

function ToolBlock({ e }) {
  // Only surface a clean shell command as IN — not the raw JSON args of every
  // tool, which just clutters the feed.
  const cmd = typeof e.input?.command === "string" ? e.input.command : null;
  const out = useStickToBottom(e.output);  // tail-follow the streaming OUT
  return (
    <div className={`acp-tool status-${e.status || "pending"}`}>
      <div className="acp-tool-head">
        <span className="acp-tool-dot" />
        <span className="acp-badge">{e.tool || "tool"}</span>
        <span className="acp-tool-title">{e.title}</span>
      </div>
      {cmd && (
        <div className="acp-tool-row"><span className="acp-gutter">IN</span><pre>{cmd}</pre></div>
      )}
      {e.output && (
        <div className="acp-tool-row">
          <span className="acp-gutter">OUT</span>
          <pre ref={out.ref} onScroll={out.onScroll}>{e.output}</pre>
        </div>
      )}
    </div>
  );
}

function Entry({ e }) {
  if (e.kind === "user") return <div className="acp-user">{e.text}</div>;
  if (e.kind === "error") return <div className="acp-error">⚠ {e.text}</div>;
  if (e.kind === "thought") return <div className="acp-thought">{e.text}</div>;
  if (e.kind === "message") {
    return (
      <div className="acp-msg">
        <Markdown remarkPlugins={[remarkGfm]}>{e.text || ""}</Markdown>
      </div>
    );
  }
  if (e.kind === "tool_call") {
    // The agent's reasoning ("think") comes through as a tool call — render it as
    // subtle reasoning text, not a heavy bordered block, to keep the feed calm.
    if (e.tool === "think") return <div className="acp-thought">{e.output || e.title}</div>;
    return <ToolBlock e={e} />;
  }
  if (e.kind === "diff") {
    return (
      <div className="acp-diff">
        <div className="acp-diff-path">{e.path}</div>
        <pre>{e.newText}</pre>
      </div>
    );
  }
  return null;
}

function Controls({ meta, onSetMode, onSetModel }) {
  const modes = meta?.modes;
  const models = meta?.models;
  if (!modes?.availableModes?.length && !models?.availableModels?.length) return null;
  return (
    <div className="acp-controls">
      {models?.availableModels?.length > 0 && (
        <select className="acp-select" value={models.currentModelId || ""}
                title="Model" onChange={(e) => onSetModel(e.target.value)}>
          {models.availableModels.map((m) => <option key={m.modelId} value={m.modelId}>{m.name}</option>)}
        </select>
      )}
      {modes?.availableModes?.length > 0 && (
        <select className="acp-select" value={modes.currentModeId || ""}
                title="Permission mode" onChange={(e) => onSetMode(e.target.value)}>
          {modes.availableModes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      )}
    </div>
  );
}

function ReplyBox({ commands, onSend, onFinish }) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const send = () => {
    const t = text.trim();
    if (t) { onSend(t); setText(""); setMenu(false); }
  };
  const pick = (name) => { setText(`/${name} `); setMenu(false); };
  const filter = text.startsWith("/") ? text.slice(1).toLowerCase() : "";
  const shown = (commands || []).filter((c) => !filter || (c.name || "").toLowerCase().includes(filter));
  return (
    <div className="acp-reply-wrap">
      {menu && shown.length > 0 && (
        <div className="acp-cmd-menu">
          {shown.slice(0, 60).map((c) => (
            <div key={c.name} className="acp-cmd-item" onClick={() => pick(c.name)}>
              <span className="acp-cmd-name">/{c.name}</span>
              {c.description && <span className="acp-cmd-desc">{c.description}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="acp-reply">
        {commands?.length > 0 && (
          <button className="acp-slash" title="Commands" onClick={() => setMenu((m) => !m)}>/</button>
        )}
        <input
          className="acp-reply-input"
          placeholder="Reply to the agent…  (type / for commands)"
          value={text}
          onChange={(e) => { const v = e.target.value; setText(v); setMenu(v.startsWith("/")); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            if (e.key === "Escape") setMenu(false);
          }}
          autoFocus
        />
        <button className="acp-reply-send" onClick={send} disabled={!text.trim()}>Send</button>
        <button className="acp-reply-finish" onClick={onFinish} title="End the session">Finish</button>
      </div>
    </div>
  );
}

export default function AcpNodeCard({ agent, status, transcript, perm, meta, onReply, onSend, onFinish, onSetMode, onSetModel }) {
  const entries = transcript?.entries || [];
  const feed = useStickToBottom(transcript, perm, status);  // tail-follow the whole feed
  const active = status === "running" || status === "waiting";
  return (
    <div className={`acp-card status-${status || "pending"} ${status === "waiting" ? "pulse" : ""}`}>
      <div className="acp-card-head">
        <span className="acp-badge agent">ACP</span>
        <span className="acp-agent">{agent}</span>
        <span className="acp-status-text">{status}</span>
      </div>
      <div className="acp-feed" ref={feed.ref} onScroll={feed.onScroll}>
        {entries.length === 0 && status !== "running" && <div className="text-faint">Waiting for the agent…</div>}
        {entries.map((e) => <Entry key={e.seq} e={e} />)}
        {status === "running" && (
          <div className="acp-working">
            <span className="acp-dots"><i></i><i></i><i></i></span>Thinking…
          </div>
        )}
        {perm && (
          <div className="acp-perm">
            <div className="acp-perm-head">⚠ {perm.title}</div>
            {perm.content && <pre className="acp-perm-content">{perm.content}</pre>}
            <div className="acp-perm-actions">
              {(perm.options || []).map((o) => (
                <button
                  key={o.id}
                  className={`acp-perm-btn kind-${o.kind || "reject"}`}
                  onClick={() => onReply(perm.requestId, o.id)}
                >
                  {o.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {active && (
        <div className="acp-footer">
          <Controls meta={meta} onSetMode={onSetMode} onSetModel={onSetModel} />
          {status === "waiting" && !perm && onSend && (
            <ReplyBox commands={meta?.commands} onSend={onSend} onFinish={onFinish} />
          )}
        </div>
      )}
    </div>
  );
}
