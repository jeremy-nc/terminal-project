"""Synchronous TeamCity REST client over Google IAP.

Two bearer headers per request: the Google IAP id_token (``Proxy-Authorization``)
gets us THROUGH the proxy; the TeamCity token (``Authorization``) authenticates to
TeamCity itself. Sync (httpx.Client) on purpose — the server calls these via
``asyncio.to_thread`` (same pattern as the Slack subdomain), so the blocking
google-auth refresh and HTTP both stay off the event loop.
"""
import httpx

DEFAULT_TIMEOUT = 30.0


class TeamCityHTTP:
    def __init__(self, base_url: str, tc_token: str, iap_token_getter, timeout: float = DEFAULT_TIMEOUT):
        self._base = (base_url or "").rstrip("/")
        self._tc_token = tc_token or ""
        self._iap = iap_token_getter      # callable -> id_token (may refresh; blocking)
        self._timeout = timeout

    def _headers(self, accept: str = "application/json") -> dict:
        iap = self._iap()
        if not iap:
            raise RuntimeError("not authenticated with Google IAP")
        headers = {"Accept": accept, "Proxy-Authorization": f"Bearer {iap}"}
        if self._tc_token:
            headers["Authorization"] = f"Bearer {self._tc_token}"
        return headers

    def get(self, path: str, params: dict = None) -> dict:
        with httpx.Client(timeout=self._timeout) as c:
            r = c.get(f"{self._base}{path}", params=params, headers=self._headers())
            r.raise_for_status()
            return r.json()

    def post(self, path: str, json_body: dict = None) -> dict:
        with httpx.Client(timeout=self._timeout) as c:
            headers = {**self._headers(), "Content-Type": "application/json"}
            r = c.post(f"{self._base}{path}", json=json_body, headers=headers)
            r.raise_for_status()
            return r.json() if r.content else {}
