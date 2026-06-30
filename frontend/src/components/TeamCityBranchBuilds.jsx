import React, { useEffect, useState, useSyncExternalStore } from "react";
import {
  subscribe, getSnapshot, watchTeamCityBranch, unwatchTeamCityBranch, teamcityBranchKey,
  watchTeamCityBuildType, unwatchTeamCityBuildType, teamcityBuildTypeKey,
  triggerTeamCityBuild,
} from "../terminalController.js";
import { TeamCityBuildRow } from "./TeamCityBuild.jsx";

const isLive = (b) => b && (b.state === "running" || b.state === "queued");

// The build's last status → LED colour. Grey ("") when nothing has run yet.
function ledClass(last) {
  if (!last) return "";
  if (last.state === "running") return "run";
  if (last.state === "queued") return "queue";
  if (last.status === "SUCCESS") return "ok";
  if (last.status === "FAILURE") return "bad";
  return "";
}

// Build configs we surface a one-click trigger button for. Each tile lists one or
// more candidate matchers (immediate sub-project name — null = directly under the
// repo's top-level project — + config name); it resolves to the FIRST candidate
// that exists in the open branch's project. This lets one tile cover differing
// project layouts (e.g. prod is "Ray White Production" for some services and
// "Stable (new-infra)" for others). Extend either list to add coverage.
const TRIGGER_TARGETS = [
  { key: "build",     label: "Build",            match: [{ sub: null, name: "Build" }] },
  { key: "rwd-apply", label: "Dev Apply + Deploy", match: [
    { sub: "Ray White Development", name: "Terraform Apply + App Deploy" },
  ] },
  { key: "rwp-plan",  label: "Prod Plan",        match: [
    { sub: "Ray White Production", name: "Terraform Plan" },
    { sub: "Stable (new-infra)",   name: "Terraform Plan" },
  ] },
];

/** Reusable: TeamCity builds for one VCS branch. Reads builds + connection state +
 *  the cached build configs from the CENTRAL store (so it drops on any tab with no
 *  prop drilling) and only takes a `branch`/`repo`. While mounted it ref-counts the
 *  branch into the poller's watched set. Renders nothing when there's no branch.
 *
 *  When the build configs for the branch's TeamCity project include any of the
 *  known TRIGGER_TARGETS, it shows a trigger button per config — with the last
 *  status for THIS branch, or "no runs yet" when the config hasn't run on it. */
export default function TeamCityBranchBuilds({ branch, repo }) {
  const { teamcityBranchBuilds, teamcityBuildTypeStatus, cicd } = useSyncExternalStore(subscribe, getSnapshot);
  const tc = cicd?.teamcity || {};
  const builds = branch ? teamcityBranchBuilds[teamcityBranchKey(repo, branch)] : undefined;

  // Optimistic per-tile "triggering…" state: config key -> true. Set on click so the
  // LED pulses immediately; cleared once a live build for that config shows up on
  // this branch (see effect below), or after a safety timeout.
  const [pending, setPending] = useState({});

  // Watch while mounted; re-register if the connection flips (triggers an
  // immediate fetch). Unwatch on unmount / branch (or repo) change.
  useEffect(() => {
    if (!branch) return undefined;
    watchTeamCityBranch(repo, branch);
    return () => unwatchTeamCityBranch(repo, branch);
  }, [repo, branch, tc.configured]);

  if (!branch) return null;   // not a git-branch workspace → hidden entirely

  // Resolve the top-level TeamCity project this branch builds under, from its most
  // recent build's project. That scopes the trigger configs to the right project
  // tree (a sub-project name like "Ray White Development" can repeat elsewhere).
  const branchBuilds = Array.isArray(builds) ? builds : [];
  const projects = tc.projects || [];
  const buildTypes = tc.buildTypes || [];
  const refBuild = branchBuilds.find((b) => b.projectId);
  const refProject = refBuild && projects.find((p) => p.id === refBuild.projectId);
  const rootId = refProject?.rootId;
  const rootName = refProject?.rootName;

  // All three tiles are always shown when connected. A tile resolves to a real
  // build config (so it can trigger) once we know the branch's project; its LED
  // reflects the last build of that config ON THIS BRANCH, read by the config's
  // own id (repo-independent — deploy configs may build a different VCS root).
  const triggers = TRIGGER_TARGETS.map((t) => {
    let bt = null;
    if (rootName) {
      for (const m of t.match) {            // first candidate that exists in this project wins
        bt = buildTypes.find((x) =>
          x.name === m.name && x.rootName === rootName &&
          (m.sub === null ? x.projectId === rootId : x.projectName === m.sub)) || null;
        if (bt) break;
      }
    }
    const last = bt ? (teamcityBuildTypeStatus[teamcityBuildTypeKey(bt.id, branch)] || null) : null;
    return { ...t, bt, last };
  });

  // Ref-count each resolved config's status into the poller's watched set so its
  // LED stays live. Re-subscribes when the resolved id set changes / connection flips.
  const watchIds = triggers.filter((t) => t.bt).map((t) => t.bt.id);
  const watchKey = watchIds.join(",");
  useEffect(() => {
    watchIds.forEach((id) => watchTeamCityBuildType(id, branch));
    return () => watchIds.forEach((id) => unwatchTeamCityBuildType(id, branch));
  }, [watchKey, branch, tc.configured]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Clear a tile's "triggering…" pulse once a live build for it appears (the backend
  // re-fetches the config's status right after queuing, so this lands within ~1s).
  useEffect(() => {
    setPending((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const t of triggers) {
        if (next[t.key] && isLive(t.last)) { delete next[t.key]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [teamcityBuildTypeStatus]);   // store identity changes when a tile's status updates

  const onTile = (t) => {
    if (!t.bt) return;   // config not in this project → inert (the button is disabled)
    setPending((p) => ({ ...p, [t.key]: true }));
    triggerTeamCityBuild(t.bt.id, branch, repo);
    // Safety net: drop the pulse after 30s even if no live build shows.
    setTimeout(() => setPending((p) => {
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

      {tc.configured && (
        <div className="tc-tiles">
          {triggers.map((t) => {
            const busy = !!pending[t.key];          // optimistic "triggering…" pulse
            const live = isLive(t.last);            // already running / queued on this branch
            const unavailable = !t.bt;              // config not in this branch's project
            const disabled = busy || live || unavailable;
            const led = busy ? "run" : ledClass(t.last);
            return (
              <button key={t.key} className={`tc-tile ${unavailable ? "tc-tile-na" : ""}`} disabled={disabled}
                title={busy
                  ? `Triggering “${t.label}” on ${branch}…`
                  : live
                    ? `“${t.bt?.name || t.label}” is ${t.last.state} on ${branch}`
                    : !t.bt
                      ? `${t.label} — not available for this branch's project yet`
                      : t.last
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
        {!tc.configured
          ? <div className="text-faint">Connect TeamCity (CI/CD tab) to see builds.</div>
          : builds === undefined
            ? <div className="text-faint">Loading…</div>
            : builds.length === 0
              ? <div className="text-faint">No builds</div>
              : builds.map((b) => <TeamCityBuildRow key={b.id} build={b} compact />)}
      </div>
    </div>
  );
}
