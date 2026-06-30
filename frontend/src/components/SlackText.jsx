import React from "react";

// A small renderer for Slack's "mrkdwn" message format. Handles the angle-bracket
// tokens — links <url|label>, user <@U…|name>, channel <#C…|name>, special <!channel>
// — plus inline *bold* _italic_ ~strike~ `code`, and unescapes &amp;/&lt;/&gt;. User
// mentions are pre-resolved to names server-side (see slack.service._resolve_mentions);
// this only turns them into readable, styled spans. Newlines are kept by CSS
// (.slack-msg-text is white-space: pre-wrap), so we don't emit <br>.

const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// Inline emphasis, applied recursively. Code is literal (no nested formatting).
const INLINE = [
  { re: /`([^`\n]+)`/, el: (inner, k) => <code key={k} className="sl-code">{inner}</code>, code: true },
  { re: /\*([^*\n]+)\*/, el: (inner, k) => <strong key={k}>{fmt(inner, k + "b")}</strong> },
  { re: /_([^_\n]+)_/, el: (inner, k) => <em key={k}>{fmt(inner, k + "i")}</em> },
  { re: /~([^~\n]+)~/, el: (inner, k) => <s key={k}>{fmt(inner, k + "s")}</s> },
];

function fmt(text, kb = "f") {
  let best = null;
  for (const rule of INLINE) {
    const m = rule.re.exec(text);
    if (m && (best === null || m.index < best.m.index)) best = { rule, m };
  }
  if (!best) return text;
  const { rule, m } = best;
  const k = kb + "-" + m.index;
  return [text.slice(0, m.index), rule.el(m[1], k), fmt(text.slice(m.index + m[0].length), k + "x")];
}

// Render one <…> token.
function token(body, k) {
  const c = body[0];
  if (c === "@" || c === "#") {                       // user / channel mention
    const label = body.includes("|") ? body.slice(body.indexOf("|") + 1) : body.slice(1);
    return <span key={k} className="sl-mention">{c === "#" ? "#" : "@"}{label}</span>;
  }
  if (c === "!") {                                    // special: <!channel> <!here> <!subteam^…|@name>
    const raw = body.slice(1);
    const label = raw.includes("|") ? raw.split("|").pop() : raw.split("^")[0];
    return <span key={k} className="sl-mention">@{label.replace(/^@/, "")}</span>;
  }
  const i = body.indexOf("|");                        // link: <url> or <url|label>
  const url = i >= 0 ? body.slice(0, i) : body;
  const label = i >= 0 ? body.slice(i + 1) : body;
  if (/^(https?:|mailto:)/.test(url)) {
    return <a key={k} className="sl-link" href={url} target="_blank" rel="noreferrer">{label}</a>;
  }
  return <span key={k}>{label}</span>;
}

export default function SlackText({ text }) {
  const src = text || "";
  const out = [];
  const re = /<([^>\n]+)>/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(fmt(unescape(src.slice(last, m.index)), "p" + i++));
    out.push(token(m[1], "t" + i++));
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(fmt(unescape(src.slice(last)), "p" + i++));
  return <>{out}</>;
}
