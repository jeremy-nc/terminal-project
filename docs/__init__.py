"""Docs File Explorer domain: watch a workspace's docs directory and broadcast its
file tree, live on OS filesystem events. Self-contained — no imports from other
domains. See ``service.py``."""
from .service import DocsService

__all__ = ["DocsService"]
