"""Workspace kinds: how a Workspace's working directory is provisioned.

A ``WorkspaceKind`` is a port. ``prepare(fields)`` provisions the working
directory and returns the effective cwd + a meta blob to persist; ``cleanup(meta,
force)`` tears it down when the Workspace is deleted. New kinds (clone-a-remote,
devcontainer, …) implement the same interface and register in ``KINDS`` — the
create modal and the create/delete flow are kind-agnostic (they read the manifest
and dispatch by id).

NB: "Workspace" is the top-level unit (workspace.py), distinct from the low-level
PTY ``Session`` (session.py). Kinds belong to the Workspace, so everything here is
``Workspace*`` — never ``Session*``.
"""
import os
import re
import subprocess


class WorkspaceError(Exception):
    """Preparing or cleaning up a workspace kind failed (bad dir, git error, …).
    Carries a human-readable message surfaced to the user."""


class WorkspaceKind:
    id = ""
    label = ""
    # Field descriptors that drive the create modal: {name, label, placeholder}.
    fields = ()

    def prepare(self, fields: dict) -> dict:
        """Provision the working dir. Return
        ``{"cwd": <path to store as workspace.dir>, "name": <default name>,
           "meta": {...}}``. Raise ``WorkspaceError`` on failure."""
        raise NotImplementedError

    def cleanup(self, meta: dict, force: bool = False) -> list:
        """Tear down on delete. Return human-readable warnings (empty = clean)."""
        return []


def _expand(path: str) -> str:
    return os.path.normpath(os.path.expanduser((path or "").strip()))


class DirectoryKind(WorkspaceKind):
    """Plain working directory: use an existing folder as-is. Nothing to clean up."""

    id = "directory"
    label = "Directory"
    fields = ({"name": "dir", "label": "path", "placeholder": "~/Code/my-project"},)

    def prepare(self, fields: dict) -> dict:
        raw = (fields.get("dir") or "").strip()
        if not raw:
            raise WorkspaceError("a directory is required")
        resolved = _expand(raw)
        if not os.path.isdir(resolved):
            raise WorkspaceError(f"directory does not exist: {resolved}")
        # Store the raw path (keeps ~ for display); resolved lazily at run time.
        return {"cwd": raw, "name": os.path.basename(resolved), "meta": {"dir": raw}}


_BRANCH_INVALID = re.compile(r"[^A-Za-z0-9._/-]+")


def _sanitize_branch(name: str) -> str:
    """Turn a workspace name into a valid git branch ref (best-effort)."""
    s = _BRANCH_INVALID.sub("-", (name or "").strip())
    s = s.replace("..", "-")          # '..' is illegal in refs
    s = re.sub(r"/{2,}", "/", s)      # collapse repeated slashes
    s = s.strip("/-.")                # no leading/trailing slash, dash, or dot
    if s.endswith(".lock"):
        s = s[:-5]
    return s


def _git(repo: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)


class WorktreeKind(WorkspaceKind):
    """Git worktree: the path is a git repo (bare or normal); ``name`` becomes a
    new branch checked out in a fresh worktree at ``<repo>.worktrees/<branch>``.
    Cleanup runs ``git worktree remove`` (safe — refuses on uncommitted changes
    unless forced) and leaves the branch intact."""

    id = "worktree"
    label = "Worktree"
    fields = (
        {"name": "dir", "label": "path", "placeholder": "~/Code/my-repo (bare or normal)"},
        {"name": "name", "label": "name", "placeholder": "conn-450-fix-user-bug"},
    )

    def _worktree_path(self, repo: str, branch: str) -> str:
        # Strip a trailing .git so a bare ~/Code/foo.git -> ~/Code/foo.worktrees/<branch>.
        base = repo[:-4] if repo.endswith(".git") else repo
        return os.path.join(base + ".worktrees", branch)

    def prepare(self, fields: dict) -> dict:
        repo = _expand(fields.get("dir") or "")
        name = (fields.get("name") or "").strip()
        if not repo:
            raise WorkspaceError("a repository path is required")
        if not name:
            raise WorkspaceError("a name is required for a worktree workspace")
        if _git(repo, "rev-parse", "--git-dir").returncode != 0:
            raise WorkspaceError(f"not a git repository: {repo}")
        branch = _sanitize_branch(name)
        if not branch:
            raise WorkspaceError(f"name does not yield a valid branch: {name!r}")
        path = self._worktree_path(repo, branch)
        if os.path.exists(path):
            raise WorkspaceError(f"worktree path already exists: {path}")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Create a NEW branch when the name is new; check out the EXISTING branch
        # when it already exists (the natural "open the ticket branch" flow). git
        # refuses if that branch is already checked out in another worktree.
        exists = _git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0
        add = _git(repo, "worktree", "add", path, *(([branch]) if exists else ["-b", branch]))
        if add.returncode != 0:
            raise WorkspaceError(f"git worktree add failed: {(add.stderr or add.stdout).strip()}")
        return {
            "cwd": path,
            "name": name,
            "meta": {"repo": repo, "name": name, "branch": branch,
                     "worktree_path": path, "new_branch": not exists},
        }

    def cleanup(self, meta: dict, force: bool = False) -> list:
        repo, path = (meta or {}).get("repo"), (meta or {}).get("worktree_path")
        if not repo or not path:
            return []
        if not os.path.exists(path):
            _git(repo, "worktree", "prune")  # already gone — just tidy metadata
            return []
        args = ["worktree", "remove", path] + (["--force"] if force else [])
        res = _git(repo, *args)
        if res.returncode != 0:
            reason = (res.stderr or res.stdout).strip() or "worktree has uncommitted changes"
            return [f"Worktree kept at {path}: {reason} (use Force to discard)"]
        _git(repo, "worktree", "prune")
        return []


KINDS = {k.id: k for k in (DirectoryKind(), WorktreeKind())}


def get_kind(kind_id: str) -> WorkspaceKind:
    """Resolve a kind id to its adapter; unknown ids fall back to directory."""
    return KINDS.get(kind_id or "directory") or KINDS["directory"]


def kinds_manifest() -> list:
    """Describe kinds for the create modal: [{id, label, fields}]."""
    return [{"id": k.id, "label": k.label, "fields": list(k.fields)} for k in KINDS.values()]
