"""Slack domain: a thin Slack client (read channels/messages/mentions, post
messages). Decoupled like the ``github.pulls`` and ``repos`` domains — no imports
from ``terminal``/``server``; the server instantiates it and broadcasts its state."""
from .service import SlackService

__all__ = ["SlackService"]
