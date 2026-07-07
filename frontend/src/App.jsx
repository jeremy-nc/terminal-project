import React, { useSyncExternalStore, useEffect, useState, useMemo } from "react";
import {
  subscribe, getSnapshot,
  newTab, activateTab, closeTab, restartTab, fitActive, refitNodes, dismissToast, playAppFx,
  openNewWorkspace, portalToWorkspace, reportFocus,
} from "./terminalController.js";
import { APP_FX_TYPES, VIEW_FX } from "./appFx.js";
import AppFx from "./components/AppFx.jsx";
import ReposMenu from "./components/ReposMenu.jsx";
import TabBar from "./components/TabBar.jsx";
import TabStage from "./components/TabStage.jsx";
import InputBar from "./components/InputBar.jsx";
import PipelineDashboard from "./components/PipelineDashboard.jsx";
import WorkspaceTabBar from "./components/WorkspaceTabBar.jsx";
import SharedNodeView from "./components/SharedNodeView.jsx";
import PullRequestsDashboard from "./components/PullRequestsDashboard.jsx";
import SlackDashboard from "./components/SlackDashboard.jsx";
import CICDDashboard from "./components/CICDDashboard.jsx";
import CollabDashboard from "./components/CollabDashboard.jsx";

export default function App() {
  const { status, tabs, activeTabId, workspaces, workspaceOrder, activeWorkspaceId, kinds, closeBlocked, toasts,
          prs, prsViewer, prsLoading, prsError, prsUpdatedAt, appFx,
          repos, repoRoots, slack, slackMessages, slackMentions, slackSentiment, slackSentiments, newWorkspace,
          automations, automationKinds, cicd, teamcityProjectBuilds, worldEntry, presence } = useSyncExternalStore(subscribe, getSnapshot);

  // WorldView portal: walking into a cavern tree jumps to the next/previous
  // workspace that has a RUNNING session (wrapping; a lone one comes out the other
  // tree). The destination's 3D view opens and the camera spawns at the exit tree.
  const onPortal = (direction) => {
    const order = workspaceOrder.length ? workspaceOrder : workspaces.map((w) => w.id);
    const running = order.filter((id) => {
      const w = workspaces.find((x) => x.id === id);
      return w && w.status === "running";
    });
    if (running.length === 0) return;
    let idx = running.indexOf(activeWorkspaceId);
    if (idx === -1) idx = 0;
    const t = direction === "next"
      ? (idx + 1) % running.length
      : (idx - 1 + running.length) % running.length;
    // entering NEXT arrives "from a lower index" → emerge at the PREV tree (and vice versa)
    portalToWorkspace(running[t], direction === "next" ? "prev" : "next");
  };
  // A shared deep-link (/shared/workspace/{wid}/t/{nodeId}) just selects the
  // Share view with this target; no separate page.
  const shareTarget = useMemo(() => {
    const m = location.pathname.match(/^\/shared\/workspace\/([^/]+)\/t\/(.+)$/);
    return m ? { workspaceId: m[1], nodeId: m[2] } : null;
  }, []);
  // A create-workspace deep-link: /pipeline/new-workspace?kind=…&dir=…&name=…
  // Pure front-end — query params just pre-fill the modal (no backend call).
  const newWorkspaceLink = useMemo(() => {
    if (location.pathname !== "/pipeline/new-workspace") return null;
    const q = new URLSearchParams(location.search);
    const fields = {};
    for (const [k, v] of q.entries()) if (k !== "kind") fields[k] = v;
    return { kind: q.get("kind") || undefined, fields };
  }, []);
  const [view, setView] = useState(
    shareTarget ? "share" : newWorkspaceLink ? "pipeline" : "terminal"); // terminal | pipeline | share | pulls
  // Interactive terminals are now server-driven + shared: the controller syncs
  // them on connect and auto-creates the first one if none exist.

  // Refit active terminal on window resize.
  useEffect(() => {
    window.addEventListener("resize", fitActive);
    return () => window.removeEventListener("resize", fitActive);
  }, []);

  // Both views are kept mounted (hidden via display:none), so on switching
  // back, recompute the now-visible terminals' sizes once laid out.
  useEffect(() => {
    if (view === "terminal") requestAnimationFrame(fitActive);
    else requestAnimationFrame(refitNodes);
  }, [view]);

  // Whole-app FX when a view opens — a single type or a combination (array).
  useEffect(() => {
    const fx = VIEW_FX[view];
    if (!fx) return;
    (Array.isArray(fx) ? fx : [fx]).forEach(playAppFx);
  }, [view]);

  // Presence: report which world this window is in — the active workspace while on
  // the pipeline view (where the WorldView renders), else nothing.
  useEffect(() => {
    reportFocus(view === "pipeline" ? activeWorkspaceId : null);
  }, [view, activeWorkspaceId]);

  // A /pipeline/new-workspace link opens the create modal pre-filled, once. Tidy
  // the URL afterward so a refresh doesn't re-open it.
  useEffect(() => {
    if (!newWorkspaceLink) return;
    openNewWorkspace(newWorkspaceLink);
    window.history.replaceState({}, "", "/");
  }, []);

  const visibleTabs = tabs.filter(t => !t.isNode || activeTabId === t.id);

  // Badge on the Pull Requests tab: distinct PRs I'm asked to review OR have left
  // a review on (union — a PR in both counts once).
  const reviewCount = useMemo(
    () => prs.filter(p => p.relations.includes("review") || p.relations.includes("reviewed")).length,
    [prs],
  );

  // Which PR repos have a local checkout (lowercased owner/name), and the action
  // that turns a PR into a pre-filled worktree workspace on its branch.
  const localRepos = useMemo(() => new Set(repos.map(r => r.name.toLowerCase())), [repos]);
  // How many workspaces are mid-run — drives the Pipeline tab's "live" badge, so a
  // background automation run is discoverable even when its tab isn't focused.
  const runningCount = useMemo(() => workspaces.filter(w => w.status === "running").length, [workspaces]);
  // Workspaces split by surface: the Pipeline screen shows pipeline (+ legacy,
  // surface-less) workspaces; the Collab screen shows collab ones. Same store,
  // filtered per screen.
  const pipelineWorkspaces = useMemo(() => workspaces.filter(w => (w.surface || "pipeline") !== "collab"), [workspaces]);
  const collabWorkspaces = useMemo(() => workspaces.filter(w => w.surface === "collab"), [workspaces]);
  // Live TeamCity builds — drives the CI/CD tab's badge, same idea as the Pipeline one.
  const cicdRunning = useMemo(
    () => (cicd?.teamcity?.builds || []).filter(b => b.state === "running" || b.state === "queued").length,
    [cicd]);
  const onWorkOnPr = (pr) => {
    const local = repos.find(r => r.name.toLowerCase() === (pr.repo || "").toLowerCase());
    if (!local) return;
    openNewWorkspace({
      kind: "worktree",
      fields: { dir: local.path, name: pr.headRefName || `pr-${pr.number}` },
    });
    setView("pipeline");
  };

  // Union of root classes from all active FX (e.g. the shake while flashing).
  const fxRootClass = appFx.map((f) => APP_FX_TYPES[f.type]?.rootClass).filter(Boolean).join(" ");

  return (
    <div className={`app${fxRootClass ? " " + fxRootClass : ""}`}>
      <div className="toolbar">
        <span className="title">Browser Terminal</span>

        <div className="view-toggle">
          <button
            className={`toggle-btn ${view === "terminal" ? "active" : ""}`}
            onClick={() => setView("terminal")}
          >
            Terminal
          </button>
          <button
            className={`toggle-btn ${view === "collab" ? "active" : ""}`}
            onClick={() => setView("collab")}
          >
            Collab
          </button>
          <button
            className={`toggle-btn ${view === "pipeline" ? "active" : ""}`}
            onClick={() => setView("pipeline")}
          >
            Pipeline
            {runningCount > 0 && (
              <span
                className="run-indicator"
                title={`${runningCount} workspace${runningCount > 1 ? "s" : ""} running`}
              >
                {runningCount}
              </span>
            )}
          </button>
          <button
            className={`toggle-btn ${view === "share" ? "active" : ""}`}
            onClick={() => setView("share")}
          >
            Share
          </button>
          <button
            className={`toggle-btn ${view === "pulls" ? "active" : ""}`}
            onClick={() => setView("pulls")}
          >
            Pull Requests
            {reviewCount > 0 && <span className="toggle-badge">{reviewCount}</span>}
          </button>
          <button
            className={`toggle-btn ${view === "slack" ? "active" : ""}`}
            onClick={() => setView("slack")}
          >
            Slack
          </button>
          <button
            className={`toggle-btn ${view === "cicd" ? "active" : ""}`}
            onClick={() => setView("cicd")}
          >
            CI/CD
            {cicdRunning > 0 && (
              <span className="run-indicator" title={`${cicdRunning} build${cicdRunning > 1 ? "s" : ""} running`}>{cicdRunning}</span>
            )}
          </button>
        </div>

        <button onClick={() => activeTabId && restartTab(activeTabId)}>
          Restart Tab
        </button>
        {/* flexible space pushes these to the right: … Repo button | Open */}
        <ReposMenu repos={repos} roots={repoRoots} />
        {presence.windows > 0 && (
          <span className="presence-chip" title={`${presence.windows} window${presence.windows > 1 ? "s" : ""} connected`}>
            ◉ {presence.windows}
          </span>
        )}
        <span className={`status status-${status}`}>{status}</span>
      </div>

      {view === "terminal" && (
        <div className="tabbar">
          <TabBar
            tabs={visibleTabs}
            activeTabId={activeTabId}
            onActivate={(id) => activateTab(id)}
            onClose={closeTab}
            onNew={newTab}
          />
        </div>
      )}

      <div className={`stage ${view === "pipeline" || view === "collab" ? "pipeline-view" : ""}`}>
        {/* Both views stay mounted and toggle via display:none so neither's
            xterm instances (or PTY sessions) are disposed on switch — unmounting
            respawns shells and refits cold, which renders garbled. */}
        <div
          className="pipeline-view-wrap"
          style={{ display: view === "pipeline" ? "flex" : "none" }}
        >
          <WorkspaceTabBar workspaces={pipelineWorkspaces} order={workspaceOrder} activeWorkspaceId={activeWorkspaceId} kinds={kinds} closeBlocked={closeBlocked} newWorkspace={newWorkspace} repos={repos} surface="pipeline" />
          <div className="ws-panels">
            {pipelineWorkspaces.length === 0 ? (
              <div className="ws-empty">Create a session (+) to define and run a pipeline.</div>
            ) : (
              // Every workspace's panel stays mounted; only the active one is
              // shown. Hiding (not unmounting) keeps each panel's node terminals
              // alive across tab switches — no lossy re-attach/replay.
              pipelineWorkspaces.map((w) => (
                <div
                  key={w.id}
                  className="ws-panel"
                  style={{ display: w.id === activeWorkspaceId ? "flex" : "none" }}
                >
                  <PipelineDashboard workspace={w} tabs={tabs} onPortal={onPortal} worldEntry={worldEntry} />
                </div>
              ))
            )}
          </div>
        </div>

        <div
          className="collab-view-wrap"
          style={{ display: view === "collab" ? "flex" : "none" }}
        >
          <WorkspaceTabBar workspaces={collabWorkspaces} order={workspaceOrder} activeWorkspaceId={activeWorkspaceId} kinds={kinds} closeBlocked={closeBlocked} newWorkspace={newWorkspace} repos={repos} surface="collab" />
          <div className="ws-panels">
            {collabWorkspaces.length === 0 ? (
              <div className="ws-empty">Create a Collab session (+) to run ACP agents.</div>
            ) : (
              collabWorkspaces.map((w) => (
                <div
                  key={w.id}
                  className="ws-panel"
                  style={{ display: w.id === activeWorkspaceId ? "flex" : "none" }}
                >
                  <CollabDashboard workspace={w} />
                </div>
              ))
            )}
          </div>
        </div>

        <div
          className="share-view-wrap"
          style={{ display: view === "share" ? "flex" : "none" }}
        >
          {shareTarget
            ? <SharedNodeView workspaceId={shareTarget.workspaceId} nodeId={shareTarget.nodeId} />
            : <div className="share-empty">
                <div className="share-empty-title">Share a terminal to view</div>
                <div className="share-empty-sub">Open a node's 🔗 link from the Pipeline view to focus a single live terminal here.</div>
              </div>}
        </div>

        <div
          className="pulls-view-wrap"
          style={{ display: view === "pulls" ? "flex" : "none" }}
        >
          <PullRequestsDashboard
            prs={prs}
            viewer={prsViewer}
            loading={prsLoading}
            error={prsError}
            updatedAt={prsUpdatedAt}
            localRepos={localRepos}
            onWorkOn={onWorkOnPr}
            automations={automations}
            automationKinds={automationKinds}
          />
        </div>

        <div
          className="slack-view-wrap"
          style={{ display: view === "slack" ? "flex" : "none" }}
        >
          <SlackDashboard slack={slack} messages={slackMessages} mentions={slackMentions}
            sentiment={slackSentiment} sentiments={slackSentiments} />
        </div>

        <div
          className="cicd-view-wrap"
          style={{ display: view === "cicd" ? "flex" : "none" }}
        >
          <CICDDashboard cicd={cicd} teamcityProjectBuilds={teamcityProjectBuilds} />
        </div>

        <div
          className="terminal-view"
          style={{ display: view === "terminal" ? "flex" : "none" }}
        >
          <div className="terminal-panes">
            <div className="main-pane">
              {tabs.map((tab) => (
                <TabStage key={tab.id} tab={tab} active={tab.id === activeTabId} />
              ))}
            </div>
            <div className="mirror-pane">
              <div className="mirror-label">Mirror (read-only)</div>
              {tabs.map((tab) => (
                <TabStage
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  isMirror
                />
              ))}
            </div>
          </div>
          {/* Command input lives under the terminal, only on the Terminal tab —
              so other views (pipeline, CI/CD, slack) reclaim the vertical space. */}
          <InputBar />
        </div>
      </div>

      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast toast-${t.kind}`}
              onClick={() => dismissToast(t.id)}
              title="Dismiss"
            >
              {t.message}
            </div>
          ))}
        </div>
      )}

      {appFx.map((f) => <AppFx key={f.key} fx={f} />)}
    </div>
  );
}
