import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { setSlackToken, setSlackApp, setSlackPolled, setSlackMultiplexers, refreshSlack, loadSlackMessages, loadSlackMentions, sendSlackMessage, setSlackSentimentConfig } from "../terminalController.js";
import SlackText from "./SlackText.jsx";

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
function SlackMessages({ channel, items, selfPoll = true, teamUrl }) {
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
            <div className="slack-msg-meta"><b>{m.user || "?"}</b> <span className="slack-msg-time">{fmtTs(m.ts)}</span>
              {teamUrl && <a className="slack-msg-link" href={slackMsgLink(teamUrl, channel, m.ts)} target="_blank" rel="noreferrer" title="Open in Slack">↗</a>}
            </div>
            <div className="slack-msg-text"><SlackText text={m.text} /></div>
          </div>
        ))}
    </div>
  );
}

/** Build a Slack archive permalink for a message — no API call needed. */
function slackMsgLink(teamUrl, channel, ts) {
  if (!teamUrl || !channel || !ts) return "";
  return `${teamUrl.replace(/\/?$/, "/")}archives/${channel}/p${String(ts).replace(".", "")}`;
}

/** Label an hour bucket: "19 Jun · 10:00 AM – 11:00 AM". */
function fmtBucket(start) {
  const end = new Date(start.getTime() + 3600000);
  const t = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${start.toLocaleDateString([], { day: "numeric", month: "short" })} · ${t(start)} – ${t(end)}`;
}

/** Read-only multiplexer: merges its channels' messages (from the polled map),
 *  sorts by time, and groups into hourly buckets — a #channel sub-label shows
 *  whenever the source changes. All merging is client-side. */
function SlackMultiplexer({ mux, channels, messages, teamUrl, sentiment, sentiments }) {
  const ref = useRef(null);
  const [nameFilter, setNameFilter] = useState("");
  const byId = (id) => channels.find((c) => c.id === id) || null;

  // slack→sentiment subdomain: the ✨ Smart toggle + "what matters to me" note are
  // GLOBAL config (live in the store); only the note's local draft is component
  // state, saved on blur/Enter so we don't send a config update per keystroke.
  const smartOn = !!sentiment?.enabled;
  const [noteDraft, setNoteDraft] = useState(sentiment?.note || "");
  useEffect(() => { setNoteDraft(sentiment?.note || ""); }, [sentiment?.note]);
  const saveNote = () => { if (noteDraft !== (sentiment?.note || "")) setSlackSentimentConfig({ note: noteDraft }); };
  const sentOf = (m) => sentiments?.[`${m.channel}:${m.ts}`];

  const merged = [];
  for (const cid of mux.channels || []) for (const m of messages[cid] || []) merged.push({ ...m, channel: cid });
  merged.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  // Author-name filter: comma-separated terms, OR-matched as case-insensitive
  // substrings — "Ke, Je" shows Kevin, Kelly, Jeremy, Jerome…
  const terms = nameFilter.toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
  const visible = terms.length
    ? merged.filter((m) => { const u = (m.user || "").toLowerCase(); return terms.some((t) => u.includes(t)); })
    : merged;

  const buckets = [];
  let cur = null;
  for (const m of visible) {
    const d = new Date(parseFloat(m.ts) * 1000);
    const key = `${d.toDateString()} ${d.getHours()}`;
    if (!cur || cur.key !== key) {
      const start = new Date(d); start.setMinutes(0, 0, 0);
      cur = { key, start, msgs: [] };
      buckets.push(cur);
    }
    cur.msgs.push(m);
  }

  useLayoutEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [visible.length]);

  if (!(mux.channels || []).length)
    return <div className="slack-empty slack-empty-center">Drag channels onto this multiplexer (sidebar or the bar above) to combine them.</div>;

  return (
    <div className="slack-mux-wrap">
      <div className="slack-mux-filter">
        <span className="slack-mux-filter-ic">🔍</span>
        <input className="slack-mux-filter-input" value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          placeholder="Filter by name…" spellCheck={false} />
        {nameFilter && <button className="slack-mux-filter-clear" title="Clear filter" onClick={() => setNameFilter("")}>×</button>}
        <button className={`slack-mux-smart ${smartOn ? "active" : ""}`}
          title="Highlight important messages (Claude triage)"
          onClick={() => setSlackSentimentConfig({ enabled: !smartOn })}>✨ Smart</button>
        {smartOn && (
          <input className="slack-mux-note" value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={saveNote}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            placeholder="What matters to you…" spellCheck={false}
            title="Tell Claude what counts as important for you" />
        )}
      </div>
      <div className="slack-mux" ref={ref}>
      {buckets.length === 0
        ? <div className="slack-empty">{terms.length ? `No messages matching ${terms.map((t) => `"${t}"`).join(", ")}.` : "No messages yet — give the poller a moment."}</div>
        : buckets.map((b) => (
          <div className="slack-hour" key={b.key}>
            <div className="slack-hour-head">{fmtBucket(b.start)}</div>
            <div className="slack-hour-card">
              {b.msgs.map((m, i) => {
                const c = byId(m.channel);
                // When Smart is on, lift flagged messages and dim the rest (until
                // scored, a message has no entry — left neutral, not dimmed).
                const s = smartOn ? sentOf(m) : null;
                const cls = s ? (s.important ? "is-important" : "is-dim") : "";
                return (
                  <div className={`slack-feed-msg ${cls}`} key={`${m.ts}-${m.channel}-${i}`}>
                    <div className="slack-feed-head">
                      <span className="slack-feed-name">{m.user || "?"}</span>
                      <span className="slack-feed-chan">{c?.is_im ? "@" : "#"}{c?.name || m.channel}</span>
                      <span className="slack-feed-time">{fmtTs(m.ts)}</span>
                      {s?.important && s.reason &&
                        <span className="slack-feed-reason" title={s.reason}>✨ {s.reason}</span>}
                      {teamUrl && <a className="slack-feed-link" href={slackMsgLink(teamUrl, m.channel, m.ts)} target="_blank" rel="noreferrer" title="Open in Slack">↗</a>}
                    </div>
                    <div className="slack-msg-text"><SlackText text={m.text} /></div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A pinned mini chat window (right panel) for a watched channel — read + post.
 *  Its channel is in the backend poller's set, so it updates without self-polling. */
function SlackPin({ channel, name, isPrivate, isIm, items, onClose, teamUrl }) {
  const [draft, setDraft] = useState("");
  const send = () => { if (draft.trim()) { sendSlackMessage(channel, draft.trim()); setDraft(""); } };
  return (
    <div className="slack-pin">
      <div className="slack-pin-head">
        <span className="slack-chan-hash">{isIm ? "@" : isPrivate ? "🔒" : "#"}</span>
        <span className="slack-pin-name">{name}</span>
        <button className="slack-pin-close" title="Unpin" onClick={onClose}>×</button>
      </div>
      <SlackMessages channel={channel} items={items} selfPoll={false} teamUrl={teamUrl} />
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
export default function SlackDashboard({ slack, messages, mentions, sentiment, sentiments }) {
  const [mode, setMode] = useState("oauth");        // "oauth" | "token" | "browser"
  const [token, setToken] = useState("");
  const [cookie, setCookie] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [selected, setSelected] = useState(null);   // channel id
  const [showMentions, setShowMentions] = useState(false);
  const [selectedMux, setSelectedMux] = useState(null);
  const [editingMux, setEditingMux] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [draft, setDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [panelsCollapsed, setPanelsCollapsed] = useState(false);  // pinned pane → thin bar
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
  const muxes = slack.multiplexers || [];
  const muxObj = muxes.find((m) => m.id === selectedMux) || null;
  const pickChannel = (id) => {
    setShowMentions(false); setSelectedMux(null); setEditingMux(false); setSelected(id);
    setUnread((u) => { const n = { ...u }; delete n[id]; return n; });   // clear its dot
    loadSlackMessages(id);
  };
  const openMentions = () => { setShowMentions(true); setSelectedMux(null); setEditingMux(false); setSelected(null); loadSlackMentions(); };
  const send = () => { if (selected && draft.trim()) { sendSlackMessage(selected, draft.trim()); setDraft(""); } };
  const toggleWatch = (id) => {
    const adding = !polled.includes(id);
    setSlackPolled(adding ? [...polled, id] : polled.filter((x) => x !== id));
    if (adding) loadSlackMessages(id);   // populate now, don't wait for the next poll
  };
  // ── multiplexers (read-only merge views; channels join the poll set server-side)
  const selectMux = (id) => { setSelectedMux(id); setSelected(null); setShowMentions(false); setEditingMux(false); };
  const renameMux = (id, name) => {
    setSlackMultiplexers(muxes.map((m) => m.id === id ? { ...m, name: (name || "").trim() || m.name } : m));
    setEditingMux(false);
  };
  const createMux = () => {
    const id = `mux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setSlackMultiplexers([...muxes, { id, name: `Multiplexer ${muxes.length + 1}`, channels: [] }]);
    selectMux(id);
  };
  const removeMux = (id) => { setSlackMultiplexers(muxes.filter((m) => m.id !== id)); if (selectedMux === id) setSelectedMux(null); };
  const addToMux = (muxId, cid) => {
    setSlackMultiplexers(muxes.map((m) =>
      m.id === muxId ? { ...m, channels: m.channels.includes(cid) ? m.channels : [...m.channels, cid] } : m));
    loadSlackMessages(cid);   // populate the merge view now, not on the next poll cycle
  };
  const removeFromMux = (muxId, cid) => setSlackMultiplexers(muxes.map((m) =>
    m.id === muxId ? { ...m, channels: m.channels.filter((c) => c !== cid) } : m));

  return (
    <div className="slack-dash">
      <div className="slack-sidebar">
        <div className="slack-side-sub">
          <span>Multiplexers</span>
          <button className="slack-refresh" title="New multiplexer" onClick={createMux}>+</button>
        </div>
        <div className="slack-mux-list">
          {muxes.length === 0
            ? <div className="slack-mux-empty">+ to create one, then drag channels in.</div>
            : muxes.map((mx) => (
              <div key={mx.id} className="slack-chan-row"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const cid = e.dataTransfer.getData("text/slack-channel"); if (cid) addToMux(mx.id, cid); }}>
                <button className={`slack-chan${selectedMux === mx.id ? " active" : ""}`} onClick={() => selectMux(mx.id)}>
                  <span className="slack-chan-hash">▦</span>{mx.name}<span className="slack-mux-count">{(mx.channels || []).length}</span>
                </button>
                <button className="slack-watch" title="Delete multiplexer" onClick={() => removeMux(mx.id)}>×</button>
              </div>
            ))}
        </div>

        <div className="slack-side-head">
          <span>Channels</span>
          <button className="slack-refresh" title="Reload channels" onClick={refreshSlack}>↻</button>
        </div>
        <button className={`slack-chan${showMentions ? " active" : ""}`} onClick={openMentions}>@ Mentions</button>
        <div className="slack-chan-list">
          {slack.channels.map((c) => {
            const pinned = polled.includes(c.id);
            const inMux = muxes.some((m) => (m.channels || []).includes(c.id));
            const dot = pinned ? " on" : inMux ? " mux" : "";
            const title = pinned ? "Pinned & polling — click to unpin"
              : inMux ? "Polled via a multiplexer — click to also pin it to the right panel"
              : "Watch for real-time updates (pin to the right panel)";
            return (
              <div key={c.id} className="slack-chan-row" draggable
                onDragStart={(e) => e.dataTransfer.setData("text/slack-channel", c.id)}>
                <button className={`slack-chan${c.id === selected ? " active" : ""}`} onClick={() => pickChannel(c.id)}>
                  <span className="slack-chan-hash">{c.is_im ? "@" : c.is_private ? "🔒" : "#"}</span>{c.name}
                  {unread[c.id] && c.id !== selected && <span className="slack-unread" />}
                </button>
                <button className={`slack-watch${dot}`} title={title} onClick={() => toggleWatch(c.id)}>●</button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="slack-main">
        {muxObj ? (
          <>
            <div className="slack-main-head">
              <span className="slack-chan-hash">▦</span>
              {editingMux ? (
                <input
                  className="slack-mux-rename" autoFocus value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => renameMux(muxObj.id, nameDraft)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditingMux(false); }}
                  spellCheck={false}
                />
              ) : (
                <>
                  {muxObj.name}
                  <button className="slack-mux-rename-btn" title="Rename" onClick={() => { setNameDraft(muxObj.name); setEditingMux(true); }}>✎</button>
                </>
              )}
            </div>
            <div className="slack-mux-chips"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const cid = e.dataTransfer.getData("text/slack-channel"); if (cid) addToMux(muxObj.id, cid); }}>
              {(muxObj.channels || []).map((cid) => {
                const c = slack.channels.find((x) => x.id === cid);
                return (
                  <span className="slack-mux-chip" key={cid}>{c?.is_im ? "@" : "#"}{c?.name || cid}
                    <button onClick={() => removeFromMux(muxObj.id, cid)}>×</button>
                  </span>
                );
              })}
              <span className="slack-mux-chip-hint">drag channels here</span>
            </div>
            <SlackMultiplexer mux={muxObj} channels={slack.channels} messages={messages} teamUrl={slack.teamUrl}
              sentiment={sentiment} sentiments={sentiments} />
          </>
        ) : showMentions ? (
          <>
            <div className="slack-main-head">Your mentions</div>
            <div className="slack-msgs">
              {mentions.length === 0
                ? <div className="slack-empty">No mentions found — needs a user token with <code>search:read</code>.</div>
                : mentions.map((m, i) => (
                  <div className="slack-msg" key={i}>
                    <div className="slack-msg-meta"><b>{m.user || "?"}</b> <span className="slack-msg-time">{fmtTs(m.ts)}</span>{m.channel ? ` · #${m.channel}` : ""}
                      {m.permalink && <a className="slack-msg-link" href={m.permalink} target="_blank" rel="noreferrer" title="Open in Slack">↗</a>}
                    </div>
                    <div className="slack-msg-text"><SlackText text={m.text} /></div>
                  </div>
                ))}
            </div>
          </>
        ) : selChannel ? (
          <>
            <div className="slack-main-head"><span className="slack-chan-hash">{selChannel.is_im ? "@" : selChannel.is_private ? "🔒" : "#"}</span>{selChannel.name}</div>
            <SlackMessages channel={selected} items={items} selfPoll={!polled.includes(selected)} teamUrl={slack.teamUrl} />
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

      {panelsCollapsed ? (
        // Collapsed: a thin vertical bar that drops back to the full pane on click.
        // Still a drop target — dragging a channel onto it pins AND re-opens the pane.
        <button
          className={`slack-panels-bar${dragOver ? " drag-over" : ""}`}
          title="Show pinned channels"
          onClick={() => setPanelsCollapsed(false)}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={() => setDragOver(true)}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false); setPanelsCollapsed(false);
            const id = e.dataTransfer.getData("text/slack-channel");
            if (id && !polled.includes(id)) { setSlackPolled([...polled, id]); loadSlackMessages(id); }
          }}
        >
          <span className="slack-panels-bar-caret">‹</span>
          <span className="slack-panels-bar-label">PINNED</span>
          {polled.length > 0 && <span className="slack-panels-bar-count">{polled.length}</span>}
        </button>
      ) : (
        <div
          className={`slack-panels${dragOver ? " drag-over" : ""}`}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={() => setDragOver(true)}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false);
            const id = e.dataTransfer.getData("text/slack-channel");
            if (id && !polled.includes(id)) { setSlackPolled([...polled, id]); loadSlackMessages(id); }
          }}
        >
          <div className="slack-panels-head">
            <span>Pinned{polled.length ? ` · ${polled.length}` : ""}</span>
            <button className="slack-panels-collapse" title="Collapse" onClick={() => setPanelsCollapsed(true)}>›</button>
          </div>
          {polled.length === 0
            ? <div className="slack-panels-empty">Drag channels here<br />for live pinned chat windows.</div>
            : polled.map((id) => {
                const c = slack.channels.find((ch) => ch.id === id);
                if (!c) return null;
                return (
                  <SlackPin key={id} channel={id} name={c.name} isPrivate={c.is_private} isIm={c.is_im}
                    items={messages[id] || []} onClose={() => toggleWatch(id)} teamUrl={slack.teamUrl} />
                );
              })}
        </div>
      )}
    </div>
  );
}
