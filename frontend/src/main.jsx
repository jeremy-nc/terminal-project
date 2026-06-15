import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App.jsx";
import SharedNodeView from "./components/SharedNodeView.jsx";

// Tiny client-side route: /shared/workspace/{wid}/t/{nodeId} → focused node view.
const shared = location.pathname.match(/^\/shared\/workspace\/([^/]+)\/t\/(.+)$/);
const root = createRoot(document.getElementById("root"));
root.render(
  shared
    ? <SharedNodeView workspaceId={shared[1]} nodeId={shared[2]} />
    : <App />
);
