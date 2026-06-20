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


def _prune_empty_parents(worktree_path: str, base: str) -> None:
    """Remove now-empty directories from the worktree's parent up to and including
    ``base`` (the ``.worktrees`` container). A slashed branch
    (``dependabot/terraform/infrastructure``) nests the worktree under intermediate
    dirs; ``git worktree remove`` deletes only the leaf, so without this the empty
    parents (and the container) linger. Stops at the first non-empty dir (another
    worktree) and never climbs above ``base``."""
    base = os.path.normpath(base)
    d = os.path.dirname(os.path.normpath(worktree_path))
    while d == base or d.startswith(base + os.sep):
        try:
            os.rmdir(d)            # only succeeds if the directory is empty
        except OSError:
            break                  # non-empty (another worktree) or already gone
        if d == base:
            break
        d = os.path.dirname(d)


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

    def _worktree_base(self, repo: str) -> str:
        # Strip a trailing .git so a bare ~/Code/foo.git -> ~/Code/foo.worktrees.
        base = repo[:-4] if repo.endswith(".git") else repo
        return base + ".worktrees"

    def _worktree_path(self, repo: str, branch: str) -> str:
        return os.path.join(self._worktree_base(repo), branch)

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
        # Choose the worktree's branch source:
        #   local branch exists        -> check it out (the "open my ticket branch" case)
        #   else origin has the branch -> fetch it + create a tracking branch
        #                                 (the dependabot / PR-branch case — the real
        #                                  commits live on origin, so we must fetch;
        #                                  fetch is non-destructive, never a merge)
        #   else                       -> create a new branch off the repo's default
        #                                 branch (origin/<default>), fetched fresh
        base_ref = None
        if _git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}").returncode == 0:
            source = "local"
            add = _git(repo, "worktree", "add", path, branch)
        elif self._origin_has_branch(repo, branch):
            source = "remote"
            fetch = _git(repo, "fetch", "origin", f"+{branch}:refs/remotes/origin/{branch}")
            if fetch.returncode != 0:
                raise WorkspaceError(f"git fetch origin {branch} failed: {(fetch.stderr or fetch.stdout).strip()}")
            add = _git(repo, "worktree", "add", "--track", "-b", branch, path, f"origin/{branch}")
        else:
            source = "new"
            # Base a genuinely-new branch on the repo's DEFAULT branch (origin/HEAD,
            # usually main), FETCHED FRESH — not the main checkout's current HEAD,
            # which may be parked on another branch and would leak its commits into
            # the new one. Fetch is non-destructive (download only, never a merge).
            # Fall back to local HEAD if the remote default can't be resolved.
            base = self._default_branch(repo)
            if base:
                _git(repo, "fetch", "origin", base)
                if _git(repo, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{base}").returncode == 0:
                    base_ref = f"origin/{base}"
            args = ["worktree", "add", "-b", branch, path] + ([base_ref] if base_ref else [])
            add = _git(repo, *args)
        if add.returncode != 0:
            _prune_empty_parents(path, self._worktree_base(repo))  # don't leave the dirs we made
            raise WorkspaceError(f"git worktree add failed: {(add.stderr or add.stdout).strip()}")
        # source: local | remote (fetched from origin) | new
        meta = {"repo": repo, "name": name, "branch": branch,
                "worktree_path": path, "source": source}
        if base_ref:
            meta["base"] = base_ref   # e.g. "origin/main" — what the new branch forks from
        return {"cwd": path, "name": name, "meta": meta}

    def _origin_has_branch(self, repo: str, branch: str) -> bool:
        r = _git(repo, "ls-remote", "--heads", "origin", branch)
        return r.returncode == 0 and bool(r.stdout.strip())

    def _default_branch(self, repo: str):
        """The remote's default branch name (e.g. 'main'), or None. Reads the local
        refs/remotes/origin/HEAD (set at clone), falling back to main/master."""
        r = _git(repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip().rsplit("/", 1)[-1]
        for b in ("main", "master"):
            if _git(repo, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{b}").returncode == 0:
                return b
        return None

    def cleanup(self, meta: dict, force: bool = False) -> list:
        repo, path = (meta or {}).get("repo"), (meta or {}).get("worktree_path")
        if not repo or not path:
            return []
        base = self._worktree_base(repo)
        if not os.path.exists(path):
            _git(repo, "worktree", "prune")  # already gone — just tidy metadata
            _prune_empty_parents(path, base)
            return []
        args = ["worktree", "remove", path] + (["--force"] if force else [])
        res = _git(repo, *args)
        if res.returncode != 0:
            reason = (res.stderr or res.stdout).strip() or "worktree has uncommitted changes"
            return [f"Worktree kept at {path}: {reason} (use Force to discard)"]
        _git(repo, "worktree", "prune")
        # Remove the now-empty parent dirs a slashed branch nested the worktree
        # under (and the .worktrees container if this was the last one).
        _prune_empty_parents(path, base)
        return []


KINDS = {k.id: k for k in (DirectoryKind(), WorktreeKind())}


def get_kind(kind_id: str) -> WorkspaceKind:
    """Resolve a kind id to its adapter; unknown ids fall back to directory."""
    return KINDS.get(kind_id or "directory") or KINDS["directory"]


def kinds_manifest() -> list:
    """Describe kinds for the create modal: [{id, label, fields}]."""
    return [{"id": k.id, "label": k.label, "fields": list(k.fields)} for k in KINDS.values()]
