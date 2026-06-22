import React, { useState, useMemo, useEffect } from "react";
import {
  setTeamCityConfig, connectTeamCity, refreshTeamCity, loadTeamCityProjectBuilds,
} from "../terminalController.js";
import { TeamCityBuildRow } from "./TeamCityBuild.jsx";

/** First-run / re-auth panel: connection settings + the Google IAP sign-in. */
function ConnectPanel({ tc }) {
  const [url, setUrl] = useState(tc.url || "");
  // The state can arrive after first render; keep the URL field in sync with it
  // (useState only captures the initial value, which may have been empty).
  useEffect(() => { setUrl(tc.url || ""); }, [tc.url]);
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const saveSettings = () => {
    setTeamCityConfig({
      url: url.trim(),
      token: token.trim() || undefined,            // only overwrite when provided
      clientId: clientId.trim() || undefined,
      clientSecret: clientSecret.trim() || undefined,
    });
    // Don't retain secrets in component state once handed to the backend; the
    // fields revert to "✓ set · leave blank to keep" (driven by the hasToken/
    // hasOauthClient flags, never the values — which the server never returns).
    setToken(""); setClientId(""); setClientSecret("");
  };
  return (
    <div className="ci-connect">
      <h2>Connect TeamCity</h2>
      <p className="ci-connect-sub">
        TeamCity sits behind Google IAP, so connecting is two parts: a TeamCity access
        token, and a one-time Google sign-in. Values already set via environment are used
        automatically — you only need to fill what's missing.
      </p>

      <label className="ci-field"><span>TeamCity URL {url && <em className="ci-set">✓ set</em>}</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://upside-ci.com.au" />
      </label>
      <label className="ci-field"><span>TeamCity access token {tc.hasToken && <em className="ci-set">✓ set</em>}</span>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
          placeholder={tc.hasToken ? "•••••••• (leave blank to keep)" : "from /profile.html?item=accessTokens"} />
      </label>
      <div className="ci-field-row">
        <label className="ci-field grow"><span>Google OAuth client ID {tc.hasOauthClient && <em className="ci-set">✓ set</em>}</span>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" />
        </label>
        <label className="ci-field grow"><span>OAuth client secret {tc.hasOauthClient && <em className="ci-set">✓ set</em>}</span>
          <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
            placeholder={tc.hasOauthClient ? "•••••••• (leave blank to keep)" : "GOCSPX-…"} />
        </label>
      </div>

      {tc.hasToken && tc.hasOauthClient && !tc.hasCreds && (
        <div className="ci-ready">
          ✓ Settings are all set — just <b>Connect with Google</b> to finish the one-time sign-in.
        </div>
      )}

      <div className="ci-connect-actions">
        <button className="ci-btn" onClick={saveSettings}>Save settings</button>
        <button className="ci-btn primary" onClick={connectTeamCity}
          disabled={!tc.hasOauthClient}
          title={tc.hasOauthClient ? "Opens a Google sign-in tab" : "Set the OAuth client first"}>
          {tc.hasCreds ? "Re-authenticate with Google" : "Connect with Google"}
        </button>
      </div>
      {tc.error && <div className="ci-error">{tc.error}</div>}
    </div>
  );
}

/** TeamCity subdomain panel — connect flow, then the build feed (recent across all
 *  projects, or a picked project's builds on demand) + per-build controls. */
export default function TeamCityPanel({ teamcity, projectBuilds = {} }) {
  const tc = teamcity || {};
  const projects = tc.projects || [];
  const [projectId, setProjectId] = useState("");   // "" = recent across all
  const [statusFilter, setStatusFilter] = useState("all");

  // Source builds: the global recent feed for "all projects", else the selected
  // project's on-demand fetch (undefined until it arrives → loading).
  const selectedBuilds = projectId ? projectBuilds[projectId] : (tc.builds || []);
  const loading = projectId && selectedBuilds === undefined;
  const builds = selectedBuilds || [];

  const onPickProject = (id) => {
    setProjectId(id);
    if (id && projectBuilds[id] === undefined) loadTeamCityProjectBuilds(id);  // fetch once
  };

  const shown = useMemo(() => builds.filter((b) => {
    if (statusFilter === "running") return b.state === "running" || b.state === "queued";
    if (statusFilter === "success") return b.status === "SUCCESS" && b.state === "finished";
    if (statusFilter === "failure") return b.status === "FAILURE";
    return true;
  }), [builds, statusFilter]);

  // Not set up yet (no token or no Google creds) → show the connect panel.
  if (!tc.configured) return <div className="ci-screen"><ConnectPanel tc={tc} /></div>;

  return (
    <div className="ci-screen">
      <div className="ci-header">
        <div className="ci-title">
          TeamCity
          <span className={`ci-conn ${tc.connected ? "on" : "off"}`} title={tc.connected ? "Connected" : "Not connected"} />
        </div>
        <div className="ci-filters">
          <select value={projectId} onChange={(e) => onPickProject(e.target.value)} className="ci-select">
            <option value="">All projects (recent)</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.path || p.name}</option>)}
          </select>
          {["all", "running", "success", "failure"].map((s) => (
            <button key={s} className={`ci-chip ${statusFilter === s ? "on" : ""}`}
              onClick={() => setStatusFilter(s)}>{s}</button>
          ))}
        </div>
        <div className="ci-header-right">
          {tc.url && <a className="ci-url" href={tc.url} target="_blank" rel="noreferrer">{tc.url.replace(/^https?:\/\//, "")}</a>}
          <button className="ci-refresh" onClick={refreshTeamCity} title="Refresh">↻</button>
        </div>
      </div>

      {tc.error && <div className="ci-error">{tc.error}</div>}

      <div className="ci-list">
        {loading && <div className="ci-empty">Loading builds…</div>}
        {!loading && shown.length === 0 && (
          <div className="ci-empty">No builds for the selected filters.</div>
        )}
        {shown.map((b) => <TeamCityBuildRow key={b.id} build={b} />)}
      </div>
    </div>
  );
}
