"""Google connect token verification helpers."""

import httpx

from fastapi import HTTPException, status
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from topix.api.utils.auth_methods import (
    get_google_client_id,
    get_google_client_secret,
    get_google_desktop_client_id,
    get_google_desktop_client_secret,
)

GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"


async def _exchange_code(
    code: str,
    code_verifier: str,
    redirect_uri: str,
    client_id: str | None,
    client_secret: str | None,
    unconfigured_detail: str,
) -> str:
    """Exchange an OAuth auth code (PKCE) for a Google ID token, server-side.

    Shared by the desktop (loopback) and web (redirect) flows — the client
    secret stays on the backend. Returns the raw `id_token`.
    """
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=unconfigured_detail,
        )
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            GOOGLE_TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "code_verifier": code_verifier,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google code exchange failed",
        )
    id_token = resp.json().get("id_token")
    if not id_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google token response missing id_token",
        )
    return id_token


async def exchange_desktop_code(code: str, code_verifier: str, redirect_uri: str) -> str:
    """Exchange a desktop loopback auth code (PKCE) for a Google ID token."""
    return await _exchange_code(
        code,
        code_verifier,
        redirect_uri,
        get_google_desktop_client_id(),
        get_google_desktop_client_secret(),
        "Google desktop sign-in is not configured",
    )


async def exchange_web_code(code: str, code_verifier: str, redirect_uri: str) -> str:
    """Exchange a web redirect auth code (PKCE) for a Google ID token.

    Uses the web OAuth client's id + secret; the browser only ever holds the
    auth code and PKCE verifier, never the secret.
    """
    return await _exchange_code(
        code,
        code_verifier,
        redirect_uri,
        get_google_client_id(),
        get_google_client_secret(),
        "Google web sign-in is not configured",
    )


def verify_google_id_token(id_token: str, audience: str | None = None) -> dict:
    """Verify a Google ID token against `audience` (default: web client id); return claims."""
    client_id = audience or get_google_client_id()
    if client_id is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google connect is not configured",
        )

    try:
        payload = google_id_token.verify_oauth2_token(
            id_token,
            google_requests.Request(),
            client_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Google ID token",
        ) from exc

    email = payload.get("email")
    if not email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google account email is missing",
        )

    if payload.get("email_verified") is not True:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google account email is not verified",
        )

    google_sub = payload.get("sub")
    if not google_sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google account identifier is missing",
        )

    return payload
