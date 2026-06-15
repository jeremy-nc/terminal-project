import React, { useSyncExternalStore, useEffect, useState, useMemo } from "react";
import {
  subscribe, getSnapshot,
  newTab, activateTab, closeTab, restartTab, fitActive, refitNodes,
} from "./terminalController.js";
import TabBar from "./components/TabBar.jsx";
import TabStage from "./components/TabStage.jsx";
import InputBar from "./components/InputBar.jsx";
import PipelineDashboard from "./components/PipelineDashboard.jsx";
import WorkspaceTabBar from "./components/WorkspaceTabBar.jsx";
import SharedNodeView from "./components/SharedNodeView.jsx";

export default function App() {
  const { status, tabs, activeTabId, workspaces, activeWorkspaceId } = useSyncExternalStore(subscribe, getSnapshot);
  // A shared deep-link (/shared/workspace/{wid}/t/{nodeId}) just selects the
  // Share view with this target; no separate page.
  const shareTarget = useMemo(() => {
    const m = location.pathname.match(/^\/shared\/workspace\/([^/]+)\/t\/(.+)$/);
    return m ? { workspaceId: m[1], nodeId: m[2] } : null;
  }, []);
  const [view, setView] = useState(shareTarget ? "share" : "terminal"); // terminal | pipeline | share
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

  const visibleTabs = tabs.filter(t => !t.isNode || activeTabId === t.id);

  return (
    <div className="app">
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
            className={`toggle-btn ${view === "pipeline" ? "active" : ""}`}
            onClick={() => setView("pipeline")}
          >
            Pipeline
          </button>
          <button
            className={`toggle-btn ${view === "share" ? "active" : ""}`}
            onClick={() => setView("share")}
          >
            Share
          </button>
        </div>

        <button onClick={() => activeTabId && restartTab(activeTabId)}>
          Restart Tab
        </button>
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

      <div className={`stage ${view === "pipeline" ? "pipeline-view" : ""}`}>
        {/* Both views stay mounted and toggle via display:none so neither's
            xterm instances (or PTY sessions) are disposed on switch — unmounting
            respawns shells and refits cold, which renders garbled. */}
        <div
          className="pipeline-view-wrap"
          style={{ display: view === "pipeline" ? "flex" : "none" }}
        >
          <WorkspaceTabBar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
          <div className="ws-panels">
            {workspaces.length === 0 ? (
              <div className="ws-empty">Create a session (+) to define and run a pipeline.</div>
            ) : (
              // Every workspace's panel stays mounted; only the active one is
              // shown. Hiding (not unmounting) keeps each panel's node terminals
              // alive across tab switches — no lossy re-attach/replay.
              workspaces.map((w) => (
                <div
                  key={w.id}
                  className="ws-panel"
                  style={{ display: w.id === activeWorkspaceId ? "flex" : "none" }}
                >
                  <PipelineDashboard workspace={w} tabs={tabs} />
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
          className="terminal-view"
          style={{ display: view === "terminal" ? "flex" : "none" }}
        >
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
      </div>

      <InputBar />
    </div>
  );
}
