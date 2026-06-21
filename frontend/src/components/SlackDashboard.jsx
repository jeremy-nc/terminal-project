import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { setSlackToken, setSlackApp, setSlackPolled, refreshSlack, loadSlackMessages, loadSlackMentions, sendSlackMessage } from "../terminalController.js";

/** Format a Slack ts ("1718800000.123456") as a short local time — just the time
 *  for today, date + time for older messages. */
function fmtTs(ts) {
  const d = new Date(parseFloat(ts) * 1000);
  if (!ts || isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** A Slack-style message list: jumps to the bottom on load / channel switch,
 *  stays pinned to the bottom when new messages arrive WHILE you're at the
 *  bottom, but leaves your scroll position alone if you've scrolled up. Polls the
 *  open channel so new messages appear. */
function SlackMessages({ channel, items, selfPoll = true }) {
  const ref = useRef(null);
  const atBottom = useRef(true);          // is the view currently pinned to bottom?
  const prevChannel = useRef(null);

  // Poll the channel for new messages — unless the backend poller already watches
  // it (selfPoll=false), to avoid double-fetching.
  useEffect(() => {
    if (!channel || !selfPoll) return;
    const id = setInterval(() => loadSlackMessages(channel), 8000);
    return () => clearInterval(id);
  }, [channel, selfPoll]);

  // Stick-to-bottom: on channel change always; on new items only if already at bottom.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const switched = prevChannel.current !== channel;
    if (switched) { prevChannel.current = channel; atBottom.current = true; }
    if (switched || atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, channel]);

  const onScroll = () => {
    const el = ref.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  return (
    <div className="slack-msgs" ref={ref} onScroll={onScroll}>
      {items.length === 0
        ? <div className="slack-empty">No messages, or this token can't read this channel.</div>
        : items.map((m, i) => (
          <div className="slack-msg" key={m.ts || i}>
            <div className="slack-msg-meta"><b>{m.user || "?"}</b> <span className="slack-msg-time">{fmtTs(m.ts)}</span></div>
            <div className="slack-msg-text">{m.text}</div>
          </div>
        ))}
    </div>
  );
}

/** A pinned mini chat window (right panel) for a watched channel — read + post.
 *  Its channel is in the backend poller's set, so it updates without self-polling. */
function SlackPin({ channel, name, isPrivate, isIm, items, onClose }) {
  const [draft, setDraft] = useState("");
  const send = () => { if (draft.trim()) { sendSlackMessage(channel, draft.trim()); setDraft(""); } };
  return (
    <div className="slack-pin">
      <div className="slack-pin-head">
        <span className="slack-chan-hash">{isIm ? "@" : isPrivate ? "🔒" : "#"}</span>
        <span className="slack-pin-name">{name}</span>
        <button className="slack-pin-close" title="Unpin" onClick={onClose}>×</button>
      </div>
      <SlackMessages channel={channel} items={items} selfPoll={false} />
      <div className="slack-pin-compose">
        <input value={draft} placeholder={`Message #${name}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }} spellCheck={false} />
      </div>
    </div>
  );
}

/** Slack tab: connect with a token (bot xoxb- or user xoxp-), browse channels +
 *  recent messages, view your mentions, and post a message. The token lives only
 *  on the server; the client just sees {configured, channels} + fetched messages. */
export default function SlackDashboard({ slack, messages, mentions }) {
  const [mode, setMode] = useState("oauth");        // "oauth" | "token" | "browser"
  const [token, setToken] = useState("");
  const [cookie, setCookie] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [selected, setSelected] = useState(null);   // channel id
  const [showMentions, setShowMentions] = useState(false);
  const [draft, setDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const prevLatest = useRef({});                 // channel id -> last-seen latest ts
  const [unread, setUnread] = useState({});      // channel id -> true (new since poll)

  // Flag watched channels that got new messages since the last poll (sidebar dot).
  // Must run before any early return (hooks rules).
  useEffect(() => {
    setUnread((u) => {
      let changed = false;
      const next = { ...u };
      for (const cid of Object.keys(messages)) {
        const arr = messages[cid];
        if (!arr || !arr.length) continue;
        const latest = arr[arr.length - 1].ts;
        const prev = prevLatest.current[cid];
        prevLatest.current[cid] = latest;
        if (prev && latest > prev && cid !== selected) { next[cid] = true; changed = true; }
      }
      return changed ? next : u;
    });
  }, [messages, selected]);

  if (!slack.configured) {
    const redirectUri = `${location.origin}/slack/oauth/callback`;
    const connect = () => {
      const t = token.trim();
      if (!t || (mode === "browser" && !cookie.trim())) return;
      setSlackToken(t, mode === "browser" ? cookie.trim() : "");
      setToken(""); setCookie("");
    };
    const connectOAuth = () => {
      const id = clientId.trim(), sec = clientSecret.trim();
      if (!id || !sec) return;
      setSlackApp(id, sec, redirectUri);
      // let the server persist the creds, then open Slack's consent in a popup
      setTimeout(() => window.open(`${location.origin}/slack/oauth/start`, "slack_oauth", "width=600,height=780"), 300);
    };
    return (
      <div className="slack-setup">
        <div className="slack-setup-title">Connect Slack</div>
        <div className="slack-mode-tabs">
          <button className={mode === "oauth" ? "active" : ""} onClick={() => setMode("oauth")}>Add to Slack</button>
          <button className={mode === "token" ? "active" : ""} onClick={() => setMode("token")}>Paste token</button>
          <button className={mode === "browser" ? "active" : ""} onClick={() => setMode("browser")}>Browser session</button>
        </div>

        {mode === "oauth" ? (
          <>
            <p className="slack-setup-help">
              Create an app at <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</a> → <b>OAuth&nbsp;&amp;&nbsp;Permissions</b>:
              add the <b>Redirect URL</b> below, plus User Token Scopes (<code>channels:history</code>, <code>groups:history</code>, <code>im:history</code>, <code>search:read</code>, <code>users:read</code>, <code>chat:write</code>).
              Then paste your Client ID/Secret (Basic Information) and connect.
            </p>
            <div className="slack-redirect">
              <label>Redirect URL — register this exact value in Slack</label>
              <code>{redirectUri}</code>
            </div>
            <div className="slack-token-row">
              <input value={clientId} placeholder="Client ID" onChange={(e) => setClientId(e.target.value)} spellCheck={false} autoComplete="off" />
            </div>
            <div className="slack-token-row">
              <input type="password" value={clientSecret} placeholder="Client Secret"
                onChange={(e) => setClientSecret(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") connectOAuth(); }}
                spellCheck={false} autoComplete="off" />
              <button disabled={!clientId.trim() || !clientSecret.trim()} onClick={connectOAuth}>Add to Slack</button>
            </div>
          </>
        ) : mode === "token" ? (
          <>
            <p className="slack-setup-help">
              Paste a <b>Bot</b> (<code>xoxb-</code>) or <b>User</b> (<code>xoxp-</code>) OAuth token from{" "}
              <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</a> → your app → <b>OAuth&nbsp;&amp;&nbsp;Permissions</b>.
              A user token reads channel history, DMs and mentions; a bot token posts and reads channels it's in.
            </p>
            <div className="slack-token-row">
              <input type="password" value={token} placeholder="xoxb-… or xoxp-…"
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
                spellCheck={false} autoComplete="off" />
              <button disabled={!token.trim()} onClick={connect}>Connect</button>
            </div>
          </>
        ) : (
          <>
            <p className="slack-setup-help">
              Reuse your logged-in web session — no app, scopes or admin approval. In a tab on <b>app.slack.com</b>, open DevTools (⌥⌘I):
            </p>
            <ol className="slack-steps">
              <li><b>Token</b> — <i>Console</i>: type <code>allow pasting</code> ↵, then paste{" "}
                <code className="slack-snippet">JSON.parse(localStorage.localConfig_v2).teams[document.location.pathname.match(/^\/client\/([A-Z0-9]+)/)[1]].token</code>
                {" "}→ starts <code>xoxc-</code>.</li>
              <li><b>Cookie</b> — <i>Application → Cookies → https://app.slack.com</i>: copy the value of the cookie named <code>d</code> → starts <code>xoxd-</code>.</li>
            </ol>
            <div className="slack-token-row">
              <input type="password" value={token} placeholder="xoxc-… (token)"
                onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" />
            </div>
            <div className="slack-token-row">
              <input type="password" value={cookie} placeholder="xoxd-… (d cookie)"
                onChange={(e) => setCookie(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
                spellCheck={false} autoComplete="off" />
              <button disabled={!token.trim() || !cookie.trim()} onClick={connect}>Connect</button>
            </div>
            <p className="slack-setup-note">⚠ The <code>d</code> cookie is your live session — kept locally (gitignored, 0600), never committed. Unofficial; it stops working when your Slack session rotates (logout / password change).</p>
          </>
        )}
      </div>
    );
  }

  const selChannel = slack.channels.find((c) => c.id === selected) || null;
  const items = messages[selected] || [];
  const polled = slack.polled || [];
  const pickChannel = (id) => {
    setShowMentions(false); setSelected(id);
    setUnread((u) => { const n = { ...u }; delete n[id]; return n; });   // clear its dot
    loadSlackMessages(id);
  };
  const openMentions = () => { setShowMentions(true); setSelected(null); loadSlackMentions(); };
  const send = () => { if (selected && draft.trim()) { sendSlackMessage(selected, draft.trim()); setDraft(""); } };
  const toggleWatch = (id) => setSlackPolled(polled.includes(id) ? polled.filter((x) => x !== id) : [...polled, id]);

  return (
    <div className="slack-dash">
      <div className="slack-sidebar">
        <div className="slack-side-head">
          <span>Channels</span>
          <button className="slack-refresh" title="Reload channels" onClick={refreshSlack}>↻</button>
        </div>
        <button className={`slack-chan${showMentions ? " active" : ""}`} onClick={openMentions}>@ Mentions</button>
        <div className="slack-chan-list">
          {slack.channels.map((c) => {
            const watched = polled.includes(c.id);
            return (
              <div key={c.id} className="slack-chan-row" draggable
                onDragStart={(e) => e.dataTransfer.setData("text/slack-channel", c.id)}>
                <button className={`slack-chan${c.id === selected ? " active" : ""}`} onClick={() => pickChannel(c.id)}>
                  <span className="slack-chan-hash">{c.is_im ? "@" : c.is_private ? "🔒" : "#"}</span>{c.name}
                  {unread[c.id] && c.id !== selected && <span className="slack-unread" />}
                </button>
                <button
                  className={`slack-watch${watched ? " on" : ""}`}
                  title={watched ? "Watching — real-time updates on. Click to stop." : "Watch for real-time updates"}
                  onClick={() => toggleWatch(c.id)}
                >●</button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="slack-main">
        {showMentions ? (
          <>
            <div className="slack-main-head">Your mentions</div>
            <div className="slack-msgs">
              {mentions.length === 0
                ? <div className="slack-empty">No mentions found — needs a user token with <code>search:read</code>.</div>
                : mentions.map((m, i) => (
                  <div className="slack-msg" key={i}>
                    <div className="slack-msg-meta"><b>{m.user || "?"}</b> <span className="slack-msg-time">{fmtTs(m.ts)}</span>{m.channel ? ` · #${m.channel}` : ""}</div>
                    <div className="slack-msg-text">{m.text}</div>
                  </div>
                ))}
            </div>
          </>
        ) : selChannel ? (
          <>
            <div className="slack-main-head"><span className="slack-chan-hash">{selChannel.is_im ? "@" : selChannel.is_private ? "🔒" : "#"}</span>{selChannel.name}</div>
            <SlackMessages channel={selected} items={items} selfPoll={!polled.includes(selected)} />
            <div className="slack-compose">
              <input
                value={draft} placeholder={`Message #${selChannel.name}`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") send(); }}
                spellCheck={false}
              />
              <button disabled={!draft.trim()} onClick={send}>Send</button>
            </div>
          </>
        ) : (
          <div className="slack-empty slack-empty-center">Pick a channel, or open <b>@ Mentions</b>.</div>
        )}
      </div>

      <div
        className={`slack-panels${dragOver ? " drag-over" : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDragEnter={() => setDragOver(true)}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false);
          const id = e.dataTransfer.getData("text/slack-channel");
          if (id && !polled.includes(id)) setSlackPolled([...polled, id]);
        }}
      >
        {polled.length === 0
          ? <div className="slack-panels-empty">Drag channels here<br />for live pinned chat windows.</div>
          : polled.map((id) => {
              const c = slack.channels.find((ch) => ch.id === id);
              if (!c) return null;
              return (
                <SlackPin key={id} channel={id} name={c.name} isPrivate={c.is_private} isIm={c.is_im}
                  items={messages[id] || []} onClose={() => toggleWatch(id)} />
              );
            })}
      </div>
    </div>
  );
}
