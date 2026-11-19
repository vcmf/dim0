"""Unit tests for the Keenable search adapter (no live network)."""

import httpx
import pytest

from topix.agents.websearch.keenable import KEYED_URL, PUBLIC_URL, TITLE, search_keenable


class _Handler(httpx.AsyncBaseTransport):
    def __init__(self, payload: dict, status: int = 200):
        self.payload = payload
        self.status = status
        self.calls: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        return httpx.Response(self.status, json=self.payload, request=request)


def _payload():
    return {
        "results": [
            {
                "title": "A",
                "url": "https://a.example",
                "snippet": "alpha",
                "acquired_at": "2026-11-19T00:00:00Z",
            },
            {
                "title": "B",
                "url": "https://b.example",
                "description": "beta",
            },
            {"title": "no-url", "snippet": "skip"},
        ]
    }


@pytest.mark.asyncio
async def test_keyless_posts_to_public_endpoint_with_title_and_no_api_key():
    handler = _Handler(_payload())
    async with httpx.AsyncClient(transport=handler) as client:
        output = await search_keenable("cats", max_results=5, client=client)

    assert len(handler.calls) == 1
    request = handler.calls[0]
    assert str(request.url) == PUBLIC_URL
    assert request.headers["X-Keenable-Title"] == TITLE
    assert "X-API-Key" not in request.headers
    assert output.search_results[0].title == "A"
    assert output.search_results[0].content == "alpha"
    assert output.search_results[1].content == "beta"
    assert all(r.url for r in output.search_results)
    assert all(getattr(r, "published_at", None) in (None, "") for r in output.search_results)


class _RedirectHandler(httpx.AsyncBaseTransport):
    def __init__(self):
        self.calls: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        return httpx.Response(
            302, headers={"Location": "https://evil.example/steal"}, request=request
        )


@pytest.mark.asyncio
async def test_keyed_posts_to_keyed_endpoint_and_does_not_follow_redirects():
    handler = _RedirectHandler()
    async with httpx.AsyncClient(transport=handler) as client:
        with pytest.raises(httpx.HTTPStatusError) as exc:
            await search_keenable("cats", api_key="secret", client=client)

    assert exc.value.response.status_code == 302
    assert len(handler.calls) == 1
    request = handler.calls[0]
    assert str(request.url) == KEYED_URL
    assert request.headers["X-API-Key"] == "secret"
