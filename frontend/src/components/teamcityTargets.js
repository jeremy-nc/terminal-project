import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import {
  subscribe, getSnapshot, teamcityBranchKey, teamcityBuildTypeKey,
  watchTeamCityBranch, unwatchTeamCityBranch,
  watchTeamCityBuildType, unwatchTeamCityBuildType, triggerTeamCityBuild,
} from "../terminalController.js";

// Shared TeamCity "trigger targets" resolution — used by the sidebar tiles
// (TeamCityBranchBuilds) AND the WorldView's optional CI/CD prop, so both read the
// same configs + live status from the central store.

export const isLive = (b) => b && (b.state === "running" || b.state === "queued");

// A build's last status → a small status key (also the LED colour class in the UI).
export function statusKey(last) {
  if (!last) return "none";
  if (last.state === "running") return "run";
  if (last.state === "queued") return "queue";
  if (last.status === "SUCCESS") return "ok";
  if (last.status === "FAILURE") return "bad";
  return "none";
}

// Build configs surfaced as one-click triggers. Each tile lists candidate matchers
// (immediate sub-project name — null = directly under the repo's top-level project —
// + config name); it resolves to the FIRST candidate that exists in the open
// branch's project, so one tile covers differing project layouts.
export const TRIGGER_TARGETS = [
  { key: "build",     label: "Build",             match: [{ sub: null, name: "Build" }] },
  { key: "rwd-apply", label: "Dev Apply + Deploy", match: [
    { sub: "Ray White Development", name: "Terraform Apply + App Deploy" },
  ] },
  { key: "rwp-plan",  label: "Prod Plan",         match: [
    { sub: "Ray White Production", name: "Terraform Plan" },
    { sub: "Stable (new-infra)",   name: "Terraform Plan" },
  ] },
];

/** Resolve the trigger targets + live status for a workspace's (branch, repo) from
 *  the central store, and manage the ref-counted status watches while mounted.
 *  Returns { configured, loading, targets:[{key,label,bt,status}], recent, trigger }. */
export function useBranchTargets(branch, repo) {
  const { teamcityBranchBuilds, teamcityBuildTypeStatus, cicd } = useSyncExternalStore(subscribe, getSnapshot);
  const tc = cicd?.teamcity || {};
  const builds = branch ? teamcityBranchBuilds[teamcityBranchKey(repo, branch)] : undefined;

  // Watch the branch while mounted (also feeds the recent-builds pile + project resolution).
  useEffect(() => {
    if (!branch) return undefined;
    watchTeamCityBranch(repo, branch);
    return () => unwatchTeamCityBranch(repo, branch);
  }, [repo, branch, tc.configured]);

  const branchBuilds = Array.isArray(builds) ? builds : [];
  const projects = tc.projects || [];
  const buildTypes = tc.buildTypes || [];
  const refBuild = branchBuilds.find((b) => b.projectId);
  const refProject = refBuild && projects.find((p) => p.id === refBuild.projectId);
  const rootId = refProject?.rootId;
  const rootName = refProject?.rootName;

  const targets = TRIGGER_TARGETS.map((t) => {
    let bt = null;
    if (rootName) {
      for (const m of t.match) {
        bt = buildTypes.find((x) =>
          x.name === m.name && x.rootName === rootName &&
          (m.sub === null ? x.projectId === rootId : x.projectName === m.sub)) || null;
        if (bt) break;
      }
    }
    const status = bt ? (teamcityBuildTypeStatus[teamcityBuildTypeKey(bt.id, branch)] || null) : null;
    return { ...t, bt, status };
  });

  // Watch each resolved config's status so its LED / can stays live.
  const watchIds = targets.filter((t) => t.bt).map((t) => t.bt.id);
  const watchKey = watchIds.join(",");
  useEffect(() => {
    watchIds.forEach((id) => watchTeamCityBuildType(id, branch));
    return () => watchIds.forEach((id) => unwatchTeamCityBuildType(id, branch));
  }, [watchKey, branch, tc.configured]);   // eslint-disable-line react-hooks/exhaustive-deps

  const trigger = (t) => { if (t && t.bt && branch) triggerTeamCityBuild(t.bt.id, branch, repo); };
  return {
    configured: !!tc.configured,
    loading: !!branch && builds === undefined,
    targets, recent: branchBuilds, trigger,
  };
}
