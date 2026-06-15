import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App.jsx";

// The /shared/... deep-link is handled inside App as the "Share" view (the
// server serves the SPA for /shared/*); no separate page.
createRoot(document.getElementById("root")).render(<App />);
