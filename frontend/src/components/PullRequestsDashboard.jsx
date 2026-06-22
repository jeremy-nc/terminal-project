import React, { useState, useMemo } from "react";
import { listPrs, saveAutomation, deleteAutomation } from "../terminalController.js";

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

/** A blank rule seeded with the first available kind. */
function emptyRule(kinds) {
  return { id: "", name: "", active: true, kind: kinds[0]?.id || "pr", match: {}, spec: "", description: "" };
}

/** Editor for one automation rule. Match fields render generically from the
 *  selected kind's manifest, so a new backend kind needs no form changes here. */
function RuleEditor({ rule, kinds, onSave, onCancel }) {
  const [draft, setDraft] = useState(rule);
  const [editingDesc, setEditingDesc] = useState(false);
  const kind = kinds.find((k) => k.id === draft.kind) || kinds[0];
  const setField = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const setMatch = (k, v) => setDraft((d) => ({ ...d, match: { ...d.match, [k]: v } }));
  return (
    <div className="auto-editor">
      <div className="auto-editor-row">
        <input className="auto-input grow" placeholder="Rule name" value={draft.name}
          onChange={(e) => setField("name", e.target.value)} />
        <select className="auto-input" value={draft.kind}
          onChange={(e) => setField("kind", e.target.value)}>
          {kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
      </div>
      <div className="auto-desc">
        {editingDesc ? (
          <textarea className="auto-input auto-desc-edit" rows={2} autoFocus
            value={draft.description ?? ""}
            onChange={(e) => setField("description", e.target.value)}
            onBlur={() => setEditingDesc(false)}
            onKeyDown={(e) => { if (e.key === "Escape") setEditingDesc(false); }} />
        ) : (
          <>
            <span className="auto-hint">{draft.description?.trim() || kind?.description || "No description."}</span>
            <button className="auto-pen" title="Edit description"
              onClick={() => { if (!draft.description) setField("description", kind?.description || ""); setEditingDesc(true); }}>✎</button>
          </>
        )}
      </div>
      <div className="auto-editor-row">
        {(kind?.match_fields || []).map((f) => (
          <label key={f.name} className="auto-field grow">
            <span>{f.label}</span>
            <input className="auto-input" placeholder={f.placeholder || ""}
              value={draft.match?.[f.name] || ""}
              onChange={(e) => setMatch(f.name, e.target.value)} />
          </label>
        ))}
      </div>
      <label className="auto-field">
        <span>Pipeline spec (DSL) — the spec decides whether an agent runs</span>
        <textarea className="auto-spec" rows={3} placeholder="seq: claude"
          value={draft.spec} onChange={(e) => setField("spec", e.target.value)} />
      </label>
      <div className="auto-editor-actions">
        <label className="auto-active">
          <input type="checkbox" checked={!!draft.active}
            onChange={(e) => setField("active", e.target.checked)} /> Active
        </label>
        <span className="auto-spacer" />
        <button className="auto-btn" onClick={onCancel}>Cancel</button>
        <button className="auto-btn primary" disabled={!draft.name.trim()}
          onClick={() => onSave(draft)}>Save</button>
      </div>
    </div>
  );
}

/** Collapsible Automations manager: list + add/edit/delete rules that turn a new
 *  matching PR into a background worktree workspace running the rule's spec. */
function AutomationsPanel({ automations, kinds }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);   // rule being edited, or null
  const kindLabel = (id) => kinds.find((k) => k.id === id)?.label || id;
  const save = (rule) => { saveAutomation(rule); setEditing(null); };
  return (
    <div className="auto-panel">
      <button className="auto-panel-head" onClick={() => setOpen((o) => !o)}>
        <span className="auto-caret">{open ? "▾" : "▸"}</span>
        Automations <span className="auto-count">{automations.length}</span>
      </button>
      {open && (
        <div className="auto-body">
          {automations.length === 0 && !editing && (
            <div className="auto-empty">
              No automations yet. Add a rule to auto-create a worktree workspace when a matching PR appears.
            </div>
          )}
          {automations.map((r) => (
            <div key={r.id} className={`auto-rule${r.active ? "" : " off"}`}>
              <div className="auto-rule-main">
                <span className={`auto-dot${r.active ? " on" : ""}`} />
                <span className="auto-rule-name">{r.name}</span>
                <span className="auto-rule-kind">{kindLabel(r.kind)}</span>
                <span className="auto-rule-match">
                  {Object.entries(r.match || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(" · ") || "any"}
                </span>
              </div>
              <div className="auto-rule-actions">
                <code className="auto-rule-spec" title={r.spec}>{r.spec || "—"}</code>
                <button className="auto-btn" onClick={() => setEditing(r)}>Edit</button>
                <button className="auto-btn danger" title="Delete" onClick={() => deleteAutomation(r.id)}>✕</button>
              </div>
            </div>
          ))}
          {editing
            ? <RuleEditor key={editing.id || "new"} rule={editing} kinds={kinds} onSave={save} onCancel={() => setEditing(null)} />
            : <button className="auto-add" onClick={() => setEditing(emptyRule(kinds))}>+ Add automation</button>}
        </div>
      )}
    </div>
  );
}

/** GitHub PR inbox: one flat list, filtered by relation chips. A PR appears once
 *  even if it matches multiple buckets (its chips show all that apply). */
export default function PullRequestsDashboard({ prs, viewer, loading, error, updatedAt, localRepos, onWorkOn, automations = [], automationKinds = [] }) {
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

      {automationKinds.length > 0 && (
        <AutomationsPanel automations={automations} kinds={automationKinds} />
      )}

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
