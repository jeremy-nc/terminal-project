"""repos: index local git checkouts under configured roots.

Maps a GitHub ``owner/name`` (as github.pulls returns it) to its local directory,
so a PR can be turned into a worktree workspace on the right local repo. The map
is derived by reading each repo's ``remote.origin.url``; only the roots are
persisted. Decoupled — no imports from ``terminal`` or ``github``.
"""
from .service import RepoIndex, DEFAULT_ROOTS

__all__ = ["RepoIndex", "DEFAULT_ROOTS"]
