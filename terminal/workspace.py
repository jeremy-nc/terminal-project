"""Workspace: a named, provisioned working directory the UI shows as a tab.

A Workspace has two parts:
  - a persisted DEFINITION (the base container: id, name, dir, kind, meta, +
    surface-specific fields on subclasses), and
  - an in-memory CONTEXT: the current runtime (a PipelineRun or CollabRun), set
    when it executes and overridden on each re-run. Not persisted.

Two orthogonal axes describe a workspace:
  - ``kind``    — how ``dir`` is provisioned (directory | worktree; workspace_kinds.py)
  - ``surface`` — the runtime type / owning screen (pipeline | collab), which
                  selects the subclass (PipelineWorkspace | CollabWorkspace).

WorkspaceStore is an in-memory registry persisted to a JSON file (the definition
subset only). It's the source of truth for "what workspaces exist"; run state is
transient and lives on each Workspace's runtime.

NB: distinct from the low-level ``Session`` in session.py (a single PTY/virtual
stream). A workspace's runtime spawns those sessions.
"""
import json
import os
import uuid

from .workspace_kinds import get_kind


class Workspace:
    """Base container: the shared definition every workspace has, plus the
    transient runtime slot. Subclasses add surface-specific fields. The
    ``surface`` class attribute is the persisted discriminator the store
    reconstructs from — orthogonal to ``kind`` (how ``dir`` is provisioned)."""

    surface = "base"

    def __init__(self, id: str, name: str, dir: str,
                 kind: str = "directory", meta: dict = None):
        self.id = id
        self.name = name
        self.dir = dir          # EFFECTIVE working directory (a kind's prepared cwd)
        # How the dir was provisioned ("directory" | "worktree" | …) and the
        # kind-specific details (repo, branch, worktree_path) used for cleanup.
        self.kind = kind or "directory"
        self.meta = meta or {}
        self.run = None         # transient runtime (PipelineRun | CollabRun); set on execute
        # Transient: True while a close is tearing down (run stopping + resource
        # cleanup). Broadcast so the tab shows "closing…"; never persisted.
        self.closing = False

    def to_json(self) -> dict:
        """The persisted definition subset (run context is transient)."""
        return {"id": self.id, "name": self.name, "dir": self.dir,
                "kind": self.kind, "meta": self.meta, "surface": self.surface}

    @classmethod
    def _base_kwargs(cls, d: dict) -> dict:
        return {"id": d["id"], "name": d.get("name", ""), "dir": d.get("dir", ""),
                "kind": d.get("kind", "directory"), "meta": d.get("meta") or {}}

    @classmethod
    def from_json(cls, d: dict) -> "Workspace":
        return cls(**cls._base_kwargs(d))


class PipelineWorkspace(Workspace):
    """A DSL-driven pipeline in a directory — the classic workspace. Owns the
    side-panel ``dsl`` and a WorldView ``theme``; its runtime is a PipelineRun."""

    surface = "pipeline"

    def __init__(self, *args, dsl: str = "", theme: str = "tropical", **kwargs):
        super().__init__(*args, **kwargs)
        self.dsl = dsl          # side-panel pipeline source
        self.theme = theme or "tropical"   # WorldView 3D theme (presentation only)

    def to_json(self) -> dict:
        return {**super().to_json(), "dsl": self.dsl, "theme": self.theme}

    @classmethod
    def from_json(cls, d: dict) -> "PipelineWorkspace":
        return cls(**cls._base_kwargs(d), dsl=d.get("dsl", ""),
                   theme=d.get("theme", "tropical"))


class CollabWorkspace(Workspace):
    """A Collab workspace: ACP agents added dynamically at runtime (no DSL). Its
    runtime is a CollabRun. No extra persisted fields yet — agents aren't persisted."""

    surface = "collab"


_WS_CLASSES = {c.surface: c for c in (PipelineWorkspace, CollabWorkspace)}


def workspace_from_json(d: dict) -> Workspace:
    """Reconstruct the right Workspace subclass from its persisted ``surface``
    (defaulting to pipeline for pre-surface data)."""
    cls = _WS_CLASSES.get(d.get("surface", "pipeline"), PipelineWorkspace)
    return cls.from_json(d)


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
                ws = workspace_from_json(d)
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
               extra_meta: dict = None, surface: str = "pipeline") -> Workspace:
        """Provision a workspace of ``kind_id`` from the modal ``fields``. The
        kind's ``prepare`` sets up the working dir (e.g. adds a git worktree) and
        returns the effective cwd + meta. ``surface`` picks the Workspace subclass
        (pipeline | collab) — orthogonal to ``kind_id``. ``extra_meta`` is merged
        onto the kind's meta (e.g. the source PR for an automation-created
        workspace). Raises WorkspaceError on failure."""
        prepared = get_kind(kind_id).prepare(fields or {})
        wid = uuid.uuid4().hex[:8]
        name = name or prepared.get("name") or f"workspace-{len(self._workspaces) + 1}"
        meta = {**(prepared.get("meta") or {}), **(extra_meta or {})}
        cls = _WS_CLASSES.get(surface, PipelineWorkspace)
        ws = cls(wid, name, prepared["cwd"], kind=kind_id, meta=meta)
        self._workspaces[wid] = ws
        self._save()
        return ws

    def set_pipeline(self, wid: str, dsl: str):
        ws = self._workspaces.get(wid)
        if isinstance(ws, PipelineWorkspace):  # only pipeline workspaces carry a DSL
            ws.dsl = dsl
            self._save()
        return ws

    def set_theme(self, wid: str, theme: str):
        ws = self._workspaces.get(wid)
        if isinstance(ws, PipelineWorkspace):  # theme is a pipeline/WorldView concern
            ws.theme = theme or "tropical"
            self._save()
        return ws

    def delete(self, wid: str):
        ws = self._workspaces.pop(wid, None)
        if ws is not None:
            self._save()
        return ws
