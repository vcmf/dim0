"""Authentication method availability helpers."""

import os

GOOGLE_CONNECT_ENABLED_ENV = "GOOGLE_CONNECT_ENABLED"
GOOGLE_CLIENT_ID_ENV = "GOOGLE_CLIENT_ID"
# Web redirect (auth-code + PKCE) sign-in exchanges the code server-side, so the
# web client needs a secret too — unlike the legacy GIS id_token flow, which
# only verifies the token against Google's public keys.
GOOGLE_CLIENT_SECRET_ENV = "GOOGLE_CLIENT_SECRET"
# Desktop (Tauri) uses a separate Google OAuth client of type "Desktop app" so the
# loopback (127.0.0.1:<any port>) redirect is allowed — the web client can't do that.
GOOGLE_DESKTOP_CLIENT_ID_ENV = "GOOGLE_DESKTOP_CLIENT_ID"
GOOGLE_DESKTOP_CLIENT_SECRET_ENV = "GOOGLE_DESKTOP_CLIENT_SECRET"


def _is_truthy(value: str | None) -> bool:
    """Parse common truthy env string values."""
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _read_env(name: str) -> str | None:
    """Return a non-empty environment variable value or None."""
    value = os.getenv(name)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def is_google_connect_enabled() -> bool:
    """Return whether Google connect is explicitly enabled."""
    return _is_truthy(os.getenv(GOOGLE_CONNECT_ENABLED_ENV))


def get_google_client_id() -> str | None:
    """Return the configured Google client id when present."""
    return _read_env(GOOGLE_CLIENT_ID_ENV)


def is_google_connect_available() -> bool:
    """Return whether Google connect is both enabled and configured."""
    return is_google_connect_enabled() and get_google_client_id() is not None


def get_google_client_secret() -> str | None:
    """Return the web Google OAuth client secret, when configured."""
    return _read_env(GOOGLE_CLIENT_SECRET_ENV)


def is_google_web_redirect_available() -> bool:
    """Whether web redirect (auth-code + PKCE) Google sign-in is configured.

    Needs the web client's id AND secret (the code exchange runs server-side).
    """
    return (
        is_google_connect_enabled()
        and get_google_client_id() is not None
        and get_google_client_secret() is not None
    )


def get_google_desktop_client_id() -> str | None:
    """Return the Google "Desktop app" OAuth client id, when configured."""
    return _read_env(GOOGLE_DESKTOP_CLIENT_ID_ENV)


def get_google_desktop_client_secret() -> str | None:
    """Return the Google "Desktop app" OAuth client secret, when configured."""
    return _read_env(GOOGLE_DESKTOP_CLIENT_SECRET_ENV)


def is_google_desktop_available() -> bool:
    """Whether desktop (loopback+PKCE) Google sign-in is configured (own id + secret)."""
    return (
        is_google_connect_enabled()
        and get_google_desktop_client_id() is not None
        and get_google_desktop_client_secret() is not None
    )
