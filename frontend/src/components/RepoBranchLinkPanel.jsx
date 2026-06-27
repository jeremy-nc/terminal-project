import React, { useMemo, useSyncExternalStore } from "react";
import { subscribe, getSnapshot } from "../terminalController.js";

// A PR checks/status pill for this panel, coloured by the GitHub status-check rollup.
const CI = {
  SUCCESS: ["ok", "checks"], FAILURE: ["bad", "failed"], ERROR: ["bad", "error"],
  PENDING: ["run", "running"], EXPECTED: ["queue", "queued"],
};
function ciPill(state) {
  if (!state) return null;
  const [cls, label] = CI[state] || ["muted", state.toLowerCase()];
  return <span className={`repo-ci ${cls}`}>● {label}</span>;
}

// A PR review-decision pill (approval state), coloured to match.
const REVIEW = {
  APPROVED: ["ok", "✓ approved"], CHANGES_REQUESTED: ["bad", "changes"], REVIEW_REQUIRED: ["queue", "review"],
};
function reviewPill(decision) {
  if (!decision) return null;
  const [cls, label] = REVIEW[decision] || ["muted", decision.toLowerCase()];
  return <span className={`repo-ci ${cls}`}>{label}</span>;
}

// Normalise a repo path for comparison: drop a trailing slash and a trailing .git
// (bare repos like ~/Code/foo.git) so the worktree's source path matches the index.
const norm = (s) => (s || "").replace(/\/+$/, "").replace(/\.git$/, "");

/** Links a worktree workspace's repository + branch (and any matching open PR) to
 *  GitHub. Self-contained (like the TeamCity panel): reads the repo index AND the PR
 *  list from the CENTRAL store. The repo index maps each local checkout's path to its
 *  GitHub ``owner/name`` (parsed from remote.origin.url), which resolves the
 *  workspace's local `repo` path to that slug; a PR is matched by that slug + the
 *  workspace's branch (headRefName). Renders nothing when the repo can't resolve
 *  (a plain-directory workspace, or a repo outside the indexed roots). */
export default function RepoBranchLinkPanel({ repo, branch }) {
  const { repos, prs } = useSyncExternalStore(subscribe, getSnapshot);
  const ownerName = useMemo(() => {
    if (!repo || !repos?.length) return null;
    const np = norm(repo);
    return repos.find((r) => norm(r.path) === np)?.name || null;
  }, [repo, repos]);
  // PRs whose head branch IS this workspace's branch, in this repo.
  const matchedPrs = useMemo(() => {
    if (!ownerName || !branch || !prs?.length) return [];
    return prs.filter((p) => p.repo === ownerName && p.headRefName === branch);
  }, [ownerName, branch, prs]);

  if (!ownerName) return null;
  const repoUrl = `https://github.com/${ownerName}`;
  const branchUrl = branch ? `${repoUrl}/tree/${branch}` : null;   // branch ref keeps its slashes

  return (
    <div className="repo-link">
      <div className="sidebar-header">Repository</div>
      <a className="repo-link-row" href={repoUrl} target="_blank" rel="noreferrer"
         title={`Open ${ownerName} on GitHub`}>
        <span className="repo-gh">GitHub</span>
        <span className="repo-name">{ownerName}</span>
        <span className="repo-ext">↗</span>
      </a>
      {branchUrl && (
        <a className="repo-link-row" href={branchUrl} target="_blank" rel="noreferrer"
           title={`Open branch ${branch} on GitHub`}>
          <span className="repo-branch" title={branch}>⎇ {branch}</span>
          <span className="repo-ext">↗</span>
        </a>
      )}
      {matchedPrs.map((p) => (
        <a key={p.id || p.number} className="repo-link-row" href={p.url} target="_blank" rel="noreferrer"
           title={p.title}>
          <span className="repo-pr">PR #{p.number}{p.isDraft ? " · draft" : ""}</span>
          <span className="repo-pr-title">{p.title}</span>
          {reviewPill(p.reviewDecision)}
          {ciPill(p.ciState)}
          <span className="repo-ext">↗</span>
        </a>
      ))}
    </div>
  );
}
