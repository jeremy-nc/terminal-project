"""Slack ``sentiment`` subdomain: optional, decoupled "is this message important?"
triage (Claude Haiku) over a side-table keyed by ``channel:ts``. Self-contained —
the parent slack domain just forwards the polled message batch to it."""
from .service import SentimentService

__all__ = ["SentimentService"]
