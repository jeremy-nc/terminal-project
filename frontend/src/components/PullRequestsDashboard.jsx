import React, { useState, useMemo } from "react";
import { listPrs } from "../terminalController.js";

const RELATION_LABELS = { raised: "Raised", assigned: "Assigned", review: "Review", reviewed: "Reviewed" };
const RELATION_ORDER = ["raised", "assigned", "review", "reviewed"];

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function ReviewBadge({ decision }) {
  if (decision === "APPROVED") return <span className="pr-badge ok">✓ approved</span>;
  if (decision === "CHANGES_REQUESTED") return <span className="pr-badge bad">✗ changes</span>;
  if (decision === "REVIEW_REQUIRED") return <span className="pr-badge muted">review required</span>;
  return null;
}

function CiBadge({ state }) {
  if (!state) return null;
  const cls = state === "SUCCESS" ? "ok" : (state === "FAILURE" || state === "ERROR") ? "bad" : "pending";
  const label = { SUCCESS: "checks", FAILURE: "failing", ERROR: "error", PENDING: "running", EXPECTED: "queued" }[state] || state.toLowerCase();
  return <span className={`pr-badge ${cls}`}>● {label}</span>;
}

/** GitHub PR inbox: one flat list, filtered by relation chips. A PR appears once
 *  even if it matches multiple buckets (its chips show all that apply). */
export default function PullRequestsDashboard({ prs, viewer, loading, error, updatedAt, localRepos, onWorkOn }) {
  const [active, setActive] = useState({ raised: true, assigned: true, review: true, reviewed: true });
  const toggle = (k) => setActive((s) => ({ ...s, [k]: !s[k] }));

  const counts = useMemo(() => {
    const c = { raised: 0, assigned: 0, review: 0, reviewed: 0 };
    prs.forEach((p) => p.relations.forEach((r) => { if (c[r] != null) c[r]++; }));
    return c;
  }, [prs]);

  const shown = useMemo(() => prs.filter((p) => p.relations.some((r) => active[r])), [prs, active]);

  return (
    <div className="pr-screen">
      <div className="pr-header">
        <div className="pr-title">
          Pull Requests {viewer && <span className="pr-viewer">@{viewer}</span>}
        </div>
        <div className="pr-chips">
          {RELATION_ORDER.map((k) => (
            <button
              key={k}
              className={`pr-chip ${active[k] ? "on" : ""}`}
              onClick={() => toggle(k)}
              title={`Toggle ${RELATION_LABELS[k]}`}
            >
              {RELATION_LABELS[k]} <span className="pr-chip-count">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="pr-header-right">
          {updatedAt && !loading && <span className="pr-updated">{timeAgo(new Date(updatedAt).toISOString())} ago</span>}
          <button className="pr-refresh" onClick={listPrs} disabled={loading} title="Refresh">
            {loading ? "…" : "↻"}
          </button>
        </div>
      </div>

      {error && (
        <div className="pr-error">
          Couldn’t load PRs: {error}
          <div className="pr-error-hint">Make sure the <code>gh</code> CLI is authed (<code>gh auth login</code>).</div>
        </div>
      )}

      <div className="pr-list">
        {shown.length === 0 && !loading && !error && (
          <div className="pr-empty">No open pull requests for the selected filters.</div>
        )}
        {shown.map((p) => (
          <a key={p.id} className="pr-row" href={p.url} target="_blank" rel="noreferrer">
            <div className="pr-row-main">
              <span className="pr-repo">{p.repo}</span>
              <span className="pr-num">#{p.number}</span>
              {p.isDraft && <span className="pr-draft">draft</span>}
              <span className="pr-rowtitle">{p.title}</span>
            </div>
            <div className="pr-row-meta">
              {p.relations.map((r) => (
                <span key={r} className={`pr-tag tag-${r}`}>{RELATION_LABELS[r]}</span>
              ))}
              <ReviewBadge decision={p.reviewDecision} />
              <CiBadge state={p.ciState} />
              {p.comments > 0 && <span className="pr-comments">💬 {p.comments}</span>}
              <span className="pr-author">{p.author}</span>
              <span className="pr-age">{timeAgo(p.updatedAt)}</span>
              {localRepos?.has((p.repo || "").toLowerCase()) && p.headRefName && (
                <button
                  className="pr-work"
                  title={`Start a worktree workspace on ${p.headRefName}`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onWorkOn(p); }}
                >
                  ⎇ Work on this
                </button>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
