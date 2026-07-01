import React, { useEffect, useState } from "react";
import { TeamCityBuildRow } from "./TeamCityBuild.jsx";
import { useBranchTargets, isLive, statusKey } from "./teamcityTargets.js";

// statusKey → the tile LED colour class. "" (grey) when nothing has run yet.
const LED = { run: "run", queue: "queue", ok: "ok", bad: "bad", none: "" };

/** Reusable: TeamCity trigger tiles + recent builds for one workspace's branch.
 *  Reads the resolved configs + live status from the CENTRAL store (via
 *  useBranchTargets), so it drops on any tab with no prop drilling. Renders nothing
 *  when there's no branch. Each of the known configs present in the branch's project
 *  gets a trigger tile with the last status for THIS branch. */
export default function TeamCityBranchBuilds({ branch, repo }) {
  const { configured, loading, targets, recent, trigger } = useBranchTargets(branch, repo);

  // Optimistic per-tile "triggering…" pulse: config key -> true. Cleared once a live
  // build for that config shows up (see effect), or after a safety timeout.
  const [pending, setPending] = useState({});

  // Clear a tile's pulse once its build goes live (backend re-fetches status ~1s
  // after queuing). Keyed on the joined status states so it runs when any changes.
  const statusSig = targets.map((t) => t.status && t.status.state).join("|");
  useEffect(() => {
    setPending((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const t of targets) {
        if (next[t.key] && isLive(t.status)) { delete next[t.key]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [statusSig]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!branch) return null;   // not a git-branch workspace → hidden entirely

  const onTile = (t) => {
    if (!t.bt) return;   // config not in this project → inert (the button is disabled)
    setPending((p) => ({ ...p, [t.key]: true }));
    trigger(t);
    setTimeout(() => setPending((p) => {   // drop the pulse after 30s regardless
      if (!p[t.key]) return p;
      const n = { ...p }; delete n[t.key]; return n;
    }), 30000);
  };

  return (
    <div className="tc-branch">
      <div className="sidebar-header tc-branch-head">
        <span>TeamCity</span>
        <code className="tc-branch-name" title={branch}>⎇ {branch}</code>
      </div>

      {configured && (
        <div className="tc-tiles">
          {targets.map((t) => {
            const busy = !!pending[t.key];          // optimistic "triggering…" pulse
            const live = isLive(t.status);          // already running / queued on this branch
            const unavailable = !t.bt;              // config not in this branch's project
            const disabled = busy || live || unavailable;
            const led = busy ? "run" : LED[statusKey(t.status)];
            return (
              <button key={t.key} className={`tc-tile ${unavailable ? "tc-tile-na" : ""}`} disabled={disabled}
                title={busy
                  ? `Triggering “${t.label}” on ${branch}…`
                  : live
                    ? `“${t.bt?.name || t.label}” is ${t.status.state} on ${branch}`
                    : !t.bt
                      ? `${t.label} — not available for this branch's project yet`
                      : t.status
                        ? `Trigger “${t.bt.name}” on ${branch}`
                        : `Trigger “${t.bt.name}” on ${branch} — no runs on this branch yet`}
                onClick={() => onTile(t)}>
                <span className="tc-tile-screen"><span className={`tc-tile-led ${led}`} /></span>
                <span className="tc-tile-label">{t.label}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="tc-branch-list">
        {!configured
          ? <div className="text-faint">Connect TeamCity (CI/CD tab) to see builds.</div>
          : loading
            ? <div className="text-faint">Loading…</div>
            : recent.length === 0
              ? <div className="text-faint">No builds</div>
              : recent.map((b) => <TeamCityBuildRow key={b.id} build={b} compact />)}
      </div>
    </div>
  );
}
