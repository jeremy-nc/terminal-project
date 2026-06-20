"""Fetch the viewer's open pull requests in one GraphQL call.

Buckets (each a "relation" to the viewer):
  - raised    -> author:@me                  (PRs you opened)
  - assigned  -> assignee:@me                (PRs assigned to you)
  - review    -> user-review-requested:@me   (you were *directly* asked to review)

A single PR can hold several relations (you authored AND were assigned), so the
three searches are merged by node id and each row is tagged with every relation
that applies — the UI shows one row with chips, not duplicates. No filtering is
applied (bots / already-reviewed included); the client filters by chip.

Auth + transport ride the `gh` CLI (its keyring token), so there's nothing to
manage here. Modelled on ~/Code/experiment-pullbar (pullBar), which uses the same
author / assignee / review-requested search buckets.
"""
import asyncio
import json

# Aliased searches in one request; PR fields mirror what pullBar surfaces (draft,
# review decision, CI rollup, comment count) so rows can show status at a glance.
_QUERY = """
query {
  raised:   search(query: "is:open is:pr author:@me archived:false", type: ISSUE, first: 50) { ...prs }
  assigned: search(query: "is:open is:pr assignee:@me archived:false", type: ISSUE, first: 50) { ...prs }
  review:   search(query: "is:open is:pr user-review-requested:@me archived:false", type: ISSUE, first: 50) { ...prs }
  reviewed: search(query: "is:open is:pr reviewed-by:@me archived:false", type: ISSUE, first: 50) { ...prs }
  viewer { login }
}
fragment prs on SearchResultItemConnection {
  nodes {
    ... on PullRequest {
      id number title url isDraft createdAt updatedAt
      headRefName isCrossRepository
      author { login avatarUrl }
      repository { nameWithOwner }
      reviewDecision
      comments { totalCount }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}
"""

RELATIONS = ("raised", "assigned", "review", "reviewed")


class GitHubAuthError(Exception):
    """`gh` is missing, unauthenticated, or the API call failed. The message is the
    gh stderr, so the UI can tell the user how to fix it (e.g. `gh auth login`)."""


def _ci_state(node: dict):
    nodes = (node.get("commits") or {}).get("nodes") or []
    if not nodes:
        return None
    roll = (nodes[0].get("commit") or {}).get("statusCheckRollup")
    return roll.get("state") if roll else None  # SUCCESS | FAILURE | PENDING | ERROR | EXPECTED


def _row(node: dict) -> dict:
    author = node.get("author") or {}
    return {
        "id": node["id"],
        "number": node["number"],
        "title": node["title"],
        "url": node["url"],
        "repo": (node.get("repository") or {}).get("nameWithOwner"),
        "isDraft": node.get("isDraft", False),
        "headRefName": node.get("headRefName"),   # the PR's branch
        "isFork": node.get("isCrossRepository", False),  # head is on a fork
        "author": author.get("login"),
        "avatarUrl": author.get("avatarUrl"),
        "createdAt": node["createdAt"],
        "updatedAt": node["updatedAt"],
        # APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
        "reviewDecision": node.get("reviewDecision"),
        "comments": (node.get("comments") or {}).get("totalCount", 0),
        "ciState": _ci_state(node),
        "relations": [],
    }


async def fetch_my_pulls() -> dict:
    """Return ``{"viewer": login, "prs": [...]}`` — open PRs across the three
    buckets, merged by id (each carrying a ``relations`` list), newest-updated
    first. Raises ``GitHubAuthError`` if gh isn't available/authed."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "gh", "api", "graphql", "-f", f"query={_QUERY}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise GitHubAuthError("the `gh` CLI is not installed")
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise GitHubAuthError((err.decode() or out.decode()).strip() or "gh api graphql failed")

    data = (json.loads(out.decode()) or {}).get("data", {}) or {}
    by_id: dict = {}
    for rel in RELATIONS:
        for node in ((data.get(rel) or {}).get("nodes") or []):
            if not node:  # a non-PR hit in the search connection
                continue
            row = by_id.get(node["id"])
            if row is None:
                row = _row(node)
                by_id[node["id"]] = row
            row["relations"].append(rel)
    prs = sorted(by_id.values(), key=lambda r: r["updatedAt"], reverse=True)
    return {"viewer": (data.get("viewer") or {}).get("login"), "prs": prs}
