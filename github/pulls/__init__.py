"""github.pulls: the viewer's open pull-request inbox.

One GraphQL call (via the `gh` CLI) returns the PRs the viewer raised, is assigned,
or was directly asked to review — merged into one list tagged by relation.
"""
from .service import fetch_my_pulls, GitHubAuthError, RELATIONS

__all__ = ["fetch_my_pulls", "GitHubAuthError", "RELATIONS"]
