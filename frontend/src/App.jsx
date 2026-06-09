import React, { useSyncExternalStore, useEffect } from "react";
import {
  subscribe, getSnapshot,
  newTab, activateTab, closeTab, restartTab, fitActive,
} from "./terminalController.js";
import TabBar from "./components/TabBar.jsx";
import TabStage from "./components/TabStage.jsx";
import InputBar from "./components/InputBar.jsx";

export default function App() {
  const { status, tabs, activeTabId } = useSyncExternalStore(subscribe, getSnapshot);

  // Open the first tab once the WebSocket is open.
  useEffect(() => {
    if (status === "open" && tabs.length === 0) newTab();
  }, [status, tabs.length]);

  // Refit active terminal on window resize.
  useEffect(() => {
    window.addEventListener("resize", fitActive);
    return () => window.removeEventListener("resize", fitActive);
  }, []);

  return (
    <div className="app">
      <div className="tabbar">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={activateTab}
          onClose={closeTab}
          onNew={newTab}
        />
      </div>

      <div className="toolbar">
        <span className="title">Browser Terminal</span>
        <button onClick={() => activeTabId && restartTab(activeTabId)}>
          Restart Tab
        </button>
        <span className={`status status-${status}`}>{status}</span>
      </div>

      <div className="stage">
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

      <InputBar />
    </div>
  );
}
