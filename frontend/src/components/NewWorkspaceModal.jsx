import React, { useState, useMemo, useEffect, useRef } from "react";

/** Create-workspace modal, rendered from the server's kind manifest so it's
 *  kind-agnostic: a radio per kind, then that kind's fields. A new backend kind
 *  appears here with no change. onCreate(kindId, fields) sends create_workspace. */
const FALLBACK_KINDS = [
  { id: "directory", label: "Directory", fields: [{ name: "dir", label: "path", placeholder: "~/Code/my-project" }] },
];

export default function NewWorkspaceModal({ kinds, onCreate, onClose, initial, repos = [] }) {
  const list = kinds && kinds.length ? kinds : FALLBACK_KINDS;
  // Seed from a prefill (deep-link / PR action) when present, else defaults.
  const seedKind = initial?.kind && list.some((k) => k.id === initial.kind) ? initial.kind : list[0].id;
  const [kindId, setKindId] = useState(seedKind);
  const kind = useMemo(() => list.find((k) => k.id === kindId) || list[0], [list, kindId]);
  const [values, setValues] = useState(initial?.fields || {});
  const [pickerOpen, setPickerOpen] = useState(false);
  const firstRef = useRef(null);

  useEffect(() => { firstRef.current?.focus(); }, [kindId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setField = (name, v) => setValues((s) => ({ ...s, [name]: v }));
  const canCreate = kind.fields.every((f) => (values[f.name] || "").trim());

  const submit = () => {
    if (!canCreate) return;
    const fields = {};
    kind.fields.forEach((f) => { fields[f.name] = (values[f.name] || "").trim(); });
    onCreate(kind.id, fields);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Workspace</div>

        <div className="modal-kinds" role="radiogroup">
          {list.map((k) => (
            <label key={k.id} className="modal-kind">
              <input
                type="radio"
                name="ws-kind"
                checked={k.id === kindId}
                onChange={() => setKindId(k.id)}
              />
              <span>{k.label}</span>
            </label>
          ))}
        </div>

        <div className="modal-fields">
          {kind.fields.map((f, i) => {
            // The path field ("dir") becomes a searchable picker over registered
            // local repos — filter by name or path, click to fill, or type freely.
            const isRepoField = f.name === "dir" && repos.length > 0;
            const q = (values[f.name] || "").trim().toLowerCase();
            const matches = isRepoField && pickerOpen
              ? repos.filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
              : [];
            const input = (
              <input
                ref={i === 0 ? firstRef : null}
                type="text"
                value={values[f.name] || ""}
                placeholder={f.placeholder || ""}
                onChange={(e) => setField(f.name, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                onFocus={isRepoField ? () => setPickerOpen(true) : undefined}
                onBlur={isRepoField ? () => setPickerOpen(false) : undefined}
                spellCheck={false}
                autoComplete="off"
              />
            );
            return (
              <div key={f.name} className="modal-field">
                <label>{f.label}</label>
                {isRepoField ? (
                  <div className="modal-repo-picker">
                    {input}
                    {matches.length > 0 && (
                      <div className="modal-repo-dropdown">
                        {matches.map((r) => (
                          <div
                            className="repos-item" key={r.name} title={r.path}
                            onMouseDown={(e) => { e.preventDefault(); setField(f.name, r.path); setPickerOpen(false); }}
                          >
                            <span className="repos-name">{r.name}</span>
                            <span className="repos-path">{r.path}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : input}
              </div>
            );
          })}
        </div>

        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-create" onClick={submit} disabled={!canCreate}>Create</button>
        </div>
      </div>
    </div>
  );
}
