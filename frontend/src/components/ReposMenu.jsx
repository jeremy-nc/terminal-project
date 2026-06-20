import React, { useState, useEffect, useRef } from "react";
import { setRepoRoots, refreshRepos } from "../terminalController.js";

/** Dropdown by the connection indicator: view the local owner/name -> path map
 *  and edit the scan roots. Roots are saved server-side (persisted + re-scanned),
 *  which broadcasts an updated repos list back to every window. */
export default function ReposMenu({ repos, roots }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(roots);
  const ref = useRef(null);

  // Re-sync the editable roots whenever the server's roots change (e.g. a save).
  useEffect(() => setDraft(roots), [roots]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const norm = (arr) => arr.map((r) => r.trim()).filter(Boolean);
  const dirty = JSON.stringify(norm(draft)) !== JSON.stringify(norm(roots));
  const save = () => setRepoRoots(norm(draft));

  return (
    <div className="repos-menu" ref={ref}>
      <button className="repos-trigger" onClick={() => setOpen((o) => !o)} title="Local repositories">
        ⎇ {repos.length}
      </button>

      {open && (
        <div className="repos-panel">
          <div className="repos-panel-head">
            <span>Local repos</span>
            <button className="repos-refresh" onClick={refreshRepos} title="Rescan roots">↻</button>
          </div>

          <div className="repos-section-label">Scan roots</div>
          {draft.map((r, i) => (
            <div className="repos-root-row" key={i}>
              <input
                value={r}
                placeholder="~/Code"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button className="repos-root-remove" title="Remove"
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <div className="repos-root-actions">
            <button className="repos-add" onClick={() => setDraft((d) => [...d, ""])}>+ Add root</button>
            <button className="repos-save" disabled={!dirty} onClick={save}>Save &amp; rescan</button>
          </div>

          <div className="repos-section-label">{repos.length} repositories</div>
          <div className="repos-list">
            {repos.length === 0 ? (
              <div className="repos-empty">No git repos found under the roots.</div>
            ) : (
              repos.map((r) => (
                <div className="repos-item" key={r.name} title={r.path}>
                  <span className="repos-name">{r.name}</span>
                  <span className="repos-path">{r.path}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
