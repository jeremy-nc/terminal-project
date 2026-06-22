"""Google IAP auth for the TeamCity subdomain — fully self-contained.

TeamCity (upside-ci.com.au) sits behind Google's Identity-Aware Proxy, so every
request needs a short-lived Google OIDC id_token (sent as ``Proxy-Authorization``)
in addition to the TeamCity token. This module owns the app's OWN Google OAuth
user credentials — obtained via an in-app browser consent (loopback redirect) and
persisted by the service — and mints/refreshes that id_token. It shares nothing
with any external tool: separate consent, separate refresh token, separate cache.
"""
import base64
import json
import time

from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials

# Minimum scopes to obtain an id_token carrying the user's identity for IAP.
OAUTH_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"]
_GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
_GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
# Loopback ports offered for the consent redirect. A Desktop OAuth client accepts
# any localhost port (RFC 8252), so these just need to be free on this machine.
_REDIRECT_PORTS = [8723, 8724, 8725, 8726]
_EXPIRY_BUFFER = 300  # refresh an id_token 5 min before it expires


def creds_from_dict(data: dict):
    """Rebuild OAuth credentials from our persisted JSON, or None."""
    if not data:
        return None
    try:
        return Credentials.from_authorized_user_info(data, scopes=OAUTH_SCOPES)
    except (ValueError, KeyError):
        return None


def creds_to_dict(creds: Credentials) -> dict:
    """Serialize OAuth credentials for persistence (includes the refresh token)."""
    return json.loads(creds.to_json())


def run_consent_flow(client_id: str, client_secret: str) -> Credentials:
    """BLOCKING: open the browser, run Google's consent on a loopback redirect,
    return user credentials (with a refresh token). Call off the event loop."""
    from google_auth_oauthlib.flow import InstalledAppFlow
    cfg = {"installed": {
        "client_id": client_id, "client_secret": client_secret,
        "auth_uri": _GOOGLE_AUTH_URI, "token_uri": _GOOGLE_TOKEN_URI,
        "redirect_uris": [f"http://localhost:{p}" for p in _REDIRECT_PORTS]}}
    flow = InstalledAppFlow.from_client_config(cfg, scopes=OAUTH_SCOPES)
    last_error = None
    for port in _REDIRECT_PORTS:
        try:
            flow.run_local_server(port=port, access_type="offline", prompt="consent",
                                  open_browser=True)
            return flow.credentials
        except OSError as e:
            last_error = e          # port busy — try the next one
    raise last_error


def _id_token_expired(tok: str) -> bool:
    if not tok:
        return True
    try:
        payload = tok.split(".")[1]
        payload += "=" * ((-len(payload)) % 4)
        exp = float(json.loads(base64.urlsafe_b64decode(payload))["exp"])
        return time.time() >= exp - _EXPIRY_BUFFER
    except (IndexError, KeyError, ValueError, json.JSONDecodeError):
        return True


def fresh_id_token(creds: Credentials):
    """A current IAP id_token from ``creds``, refreshing if stale. Returns
    ``(id_token, refreshed)`` — ``refreshed`` True if the creds changed and should
    be re-persisted. ``id_token`` is None if the creds can't produce one (the
    caller should re-run consent)."""
    if creds is None:
        return None, False
    if creds.id_token and not _id_token_expired(creds.id_token):
        return creds.id_token, False
    try:
        creds.refresh(GoogleAuthRequest())
        return creds.id_token, True
    except Exception:
        return None, False
