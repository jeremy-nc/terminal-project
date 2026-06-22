"""Workspace: a named pipeline-in-a-directory.

A Workspace is the top-level unit the UI shows as a "session" tab. It owns:
  - a persisted DEFINITION: id, name, dir, dsl (the side-panel text), and
  - an in-memory CONTEXT: the current PipelineRun (node outputs, status), set
    when it executes and overridden on each re-run. Not persisted.

WorkspaceStore is an in-memory registry persisted to a JSON file (the definition
subset only). It's the source of truth for "what sessions exist"; run state is
transient and lives on each Workspace's PipelineRun.

NB: distinct from the low-level ``Session`` in session.py (a single PTY/virtual
stream). A Workspace runs a pipeline whose nodes spawn those PTY sessions.
"""
import json
import os
import uuid

from .workspace_kinds import get_kind


class Workspace:
    def __init__(self, id: str, name: str, dir: str, dsl: str = "",
                 kind: str = "directory", meta: dict = None):
        self.id = id
        self.name = name
        self.dir = dir          # EFFECTIVE working directory (a kind's prepared cwd)
        self.dsl = dsl          # side-panel pipeline source
        # How the dir was provisioned ("directory" | "worktree" | …) and the
        # kind-specific details (repo, branch, worktree_path) used for cleanup.
        self.kind = kind or "directory"
        self.meta = meta or {}
        self.run = None         # current PipelineRun (in-memory context); set on execute
        # Transient: True while a close is tearing down (run stopping + resource
        # cleanup). Broadcast so the tab shows "closing…"; never persisted.
        self.closing = False

    def to_json(self) -> dict:
        """The persisted definition subset (run context is transient)."""
        return {"id": self.id, "name": self.name, "dir": self.dir, "dsl": self.dsl,
                "kind": self.kind, "meta": self.meta}

    @classmethod
    def from_json(cls, d: dict) -> "Workspace":
        return cls(d["id"], d.get("name", ""), d.get("dir", ""), d.get("dsl", ""),
                   kind=d.get("kind", "directory"), meta=d.get("meta") or {})


class WorkspaceStore:
    def __init__(self, path: str):
        self._path = path
        self._workspaces = {}  # id -> Workspace (insertion-ordered)
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self._path):
            return
        try:
            with open(self._path) as f:
                data = json.load(f)
            for d in data.get("workspaces", []):
                ws = Workspace.from_json(d)
                self._workspaces[ws.id] = ws
        except (OSError, ValueError, KeyError) as e:
            print(f"[workspace] load failed ({self._path}): {e}", flush=True)

    def _save(self) -> None:
        # Atomic write so a crash mid-save can't truncate the store.
        try:
            tmp = self._path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"workspaces": [w.to_json() for w in self._workspaces.values()]}, f, indent=2)
            os.replace(tmp, self._path)
        except OSError as e:
            print(f"[workspace] save failed ({self._path}): {e}", flush=True)

    def list(self) -> list:
        return list(self._workspaces.values())

    def get(self, wid: str):
        return self._workspaces.get(wid)

    def find_existing(self, kind_id: str, fields: dict):
        """The existing workspace that get-or-create would collide with, or
        ``None``. Only kinds with a stable identity dedupe (worktree: one per
        repo+branch); others (a plain directory) always create a fresh one, so
        this returns ``None`` for them and the caller proceeds to create."""
        kind = get_kind(kind_id)
        key = kind.identity(fields or {})
        if not key:
            return None
        for ws in self._workspaces.values():
            if ws.kind == kind_id and kind.identity_of(ws) == key:
                return ws
        return None

    def create(self, kind_id: str, fields: dict, name: str = None,
               extra_meta: dict = None) -> Workspace:
        """Provision a workspace of ``kind_id`` from the modal ``fields``. The
        kind's ``prepare`` sets up the working dir (e.g. adds a git worktree) and
        returns the effective cwd + meta. ``extra_meta`` is merged onto the kind's
        meta (e.g. the source PR for an automation-created workspace). Raises
        WorkspaceError on failure."""
        prepared = get_kind(kind_id).prepare(fields or {})
        wid = uuid.uuid4().hex[:8]
        name = name or prepared.get("name") or f"workspace-{len(self._workspaces) + 1}"
        meta = {**(prepared.get("meta") or {}), **(extra_meta or {})}
        ws = Workspace(wid, name, prepared["cwd"], "", kind=kind_id, meta=meta)
        self._workspaces[wid] = ws
        self._save()
        return ws

    def set_pipeline(self, wid: str, dsl: str):
        ws = self._workspaces.get(wid)
        if ws is not None:
            ws.dsl = dsl
            self._save()
        return ws

    def delete(self, wid: str):
        ws = self._workspaces.pop(wid, None)
        if ws is not None:
            self._save()
        return ws
