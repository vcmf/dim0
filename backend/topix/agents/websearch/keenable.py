"""Keyless Keenable Search adapter for the /ai/search relay and server-side tools.

Works without a key against the public endpoint. An optional key uses the
keyed endpoint and is never sent on a redirect.
"""

from typing import Optional

import httpx

from topix.agents.datatypes.annotations import SearchResult
from topix.agents.datatypes.outputs import WebSearchOutput
from topix.agents.datatypes.web_search import WebSearchContextSize
from topix.datatypes.recurrence import Recurrence

PUBLIC_URL = "https://api.keenable.ai/v1/search/public"
KEYED_URL = "https://api.keenable.ai/v1/search"
TITLE = "Dim0"
DEFAULT_TIMEOUT = httpx.Timeout(60)
USER_AGENT = "Dim0 (https://github.com/vcmf/dim0)"


def _headers(api_key: str | None) -> dict[str, str]:
    """Build request headers. The title identifies this app on the public pool."""
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Keenable-Title": TITLE,
    }
    if api_key:
        headers["X-API-Key"] = api_key
    return headers


async def search_keenable(
    query: str,
    max_results: int = 10,
    search_context_size: WebSearchContextSize = WebSearchContextSize.MEDIUM,
    recency: Recurrence | None = None,
    *,
    api_key: Optional[str] = None,
    client: Optional[httpx.AsyncClient] = None,
    timeout: Optional[httpx.Timeout] = None,
) -> WebSearchOutput:
    """Search the web with Keenable, keyless by default.

    The signature matches the other websearch engines so the /ai/search relay
    can dispatch by name. `search_context_size` and `recency` are accepted and
    unused: Keenable's request body does not document equivalents here.
    A key, when given, is sent only to the keyed endpoint, and redirects are
    refused so that header cannot follow a new location.
    """
    del search_context_size, recency
    url = KEYED_URL if api_key else PUBLIC_URL
    payload = {"query": query, "max_results": max_results}
    request_timeout = timeout or DEFAULT_TIMEOUT
    # Refuse redirects on keyed calls so X-API-Key cannot follow a new location.
    follow = not bool(api_key)

    if client is None:
        async with httpx.AsyncClient(follow_redirects=follow) as ac:
            resp = await ac.post(
                url, headers=_headers(api_key), json=payload, timeout=request_timeout
            )
    else:
        resp = await client.post(
            url,
            headers=_headers(api_key),
            json=payload,
            timeout=request_timeout,
            follow_redirects=follow,
        )

    resp.raise_for_status()
    results = (resp.json() or {}).get("results") or []
    search_results: list[SearchResult] = []
    for result in results[:max_results]:
        if not result.get("url"):
            continue
        search_results.append(
            SearchResult(
                url=result["url"],
                title=result.get("title") or "",
                content=result.get("snippet") or result.get("description") or "",
            )
        )
    return WebSearchOutput(search_results=search_results, answer="")
