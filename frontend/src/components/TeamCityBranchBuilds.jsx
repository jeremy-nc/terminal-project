import React, { useEffect, useSyncExternalStore } from "react";
import {
  subscribe, getSnapshot, watchTeamCityBranch, unwatchTeamCityBranch, teamcityBranchKey,
} from "../terminalController.js";
import { TeamCityBuildRow } from "./TeamCityBuild.jsx";

/** Reusable: TeamCity builds for one VCS branch. Reads builds + connection state
 *  from the CENTRAL store (so it can be dropped on any tab with no prop drilling)
 *  and only takes a `branch`. While mounted it ref-counts the branch into the
 *  backend poller's watched set (one poll per branch no matter how many panels),
 *  so it stays live. Renders nothing when there's no branch (non-git workspace). */
export default function TeamCityBranchBuilds({ branch, repo }) {
  const { teamcityBranchBuilds, cicd } = useSyncExternalStore(subscribe, getSnapshot);
  const tc = cicd?.teamcity || {};
  const builds = branch ? teamcityBranchBuilds[teamcityBranchKey(repo, branch)] : undefined;

  // Watch while mounted; re-register if the connection flips (triggers an
  // immediate fetch). Unwatch on unmount / branch (or repo) change.
  useEffect(() => {
    if (!branch) return undefined;
    watchTeamCityBranch(repo, branch);
    return () => unwatchTeamCityBranch(repo, branch);
  }, [repo, branch, tc.configured]);

  if (!branch) return null;   // not a git-branch workspace → hidden entirely

  return (
    <div className="tc-branch">
      <div className="sidebar-header tc-branch-head">
        <span>TeamCity</span>
        <code className="tc-branch-name" title={branch}>⎇ {branch}</code>
      </div>
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
