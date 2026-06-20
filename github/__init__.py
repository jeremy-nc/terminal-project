"""github: integrations with GitHub, decoupled from the terminal/workspace domain.

Subdomains (e.g. ``pulls``) own their own data fetching and shapes. They expose
plain async functions / dataclasses; the websocket layer in server.py is the only
thing that bridges them to the client — nothing here imports from ``terminal``.
"""
