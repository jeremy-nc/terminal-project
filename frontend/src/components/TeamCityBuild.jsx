import React from "react";
import { cancelTeamCityBuild, rerunTeamCityBuild } from "../terminalController.js";

/** Relative age from an epoch-ms timestamp. */
export function buildTimeAgo(ms) {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 0) return "soon";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Status pill for one build: running/queued (live), success, failure, other. */
export function StatusPill({ build }) {
  if (build.state === "running") return <span className="ci-pill running">● running</span>;
  if (build.state === "queued") return <span className="ci-pill queued">◴ queued</span>;
  if (build.status === "SUCCESS") return <span className="ci-pill ok">✓ success</span>;
  if (build.status === "FAILURE") return <span className="ci-pill bad">✗ failed</span>;
  return <span className="ci-pill muted">{(build.status || "—").toLowerCase()}</span>;
}

/** Short commit hash for a build: the revision SHA if present, else the hash
 *  embedded in the build number (`<counter>.<sha>`). */
function shortHash(b) {
  const rev = b.revision || "";
  if (rev) return rev.slice(0, 7);
  const num = String(b.number || "");
  const dot = num.indexOf(".");
  const h = dot >= 0 ? num.slice(dot + 1) : "";
  return h ? h.slice(0, 7) : (num || String(b.id || ""));
}

/** Reusable build row. Full mode (CI/CD feed) shows project/name/branch/age +
 *  controls. `compact` mode (the per-workspace branch panel, where the repo is
 *  already known) shows just status · short hash · open-in-TeamCity. */
export function TeamCityBuildRow({ build, showProject = true, showBranch = true, compact = false }) {
  const b = build;
  if (compact) {
    return (
      <div className="ci-row compact">
        <StatusPill build={b} />
        <code className="ci-hash" title={b.number || b.id}>{shortHash(b)}</code>
        <span className="ci-row-spacer" />
        {b.webUrl && <a className="ci-open" href={b.webUrl} target="_blank" rel="noreferrer" title="Open in TeamCity">open ↗</a>}
      </div>
    );
  }
  const live = b.state === "running" || b.state === "queued";
  const when = b.finished || b.started || b.queued;
  return (
    <div className="ci-row">
      <StatusPill build={b} />
      <div className="ci-row-main">
        {showProject && <span className="ci-proj">{b.project}</span>}
        <span className="ci-name">{b.name}</span>
        <span className="ci-num">#{b.number || b.id}</span>
        {showBranch && b.branch && <span className="ci-branch">⎇ {b.branch}</span>}
      </div>
      <div className="ci-row-meta">
        {when && <span className="ci-age">{buildTimeAgo(when)}</span>}
        {b.webUrl && <a className="ci-link" href={b.webUrl} target="_blank" rel="noreferrer" title="Open in TeamCity">↗</a>}
        {live
          ? <button className="ci-act cancel" title="Stop / dequeue" onClick={() => cancelTeamCityBuild(b.id, b.state)}>✕ stop</button>
          : <button className="ci-act rerun" title="Re-run this build" onClick={() => rerunTeamCityBuild(b.id)}>↻ re-run</button>}
      </div>
    </div>
  );
}
