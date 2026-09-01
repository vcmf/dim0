"""Web redirect (auth-code + PKCE) Google availability gating."""

import pytest

from topix.api.utils import auth_methods


ENV = (
    auth_methods.GOOGLE_CONNECT_ENABLED_ENV,
    auth_methods.GOOGLE_CLIENT_ID_ENV,
    auth_methods.GOOGLE_CLIENT_SECRET_ENV,
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in ENV:
        monkeypatch.delenv(key, raising=False)


def test_client_secret_reads_env(monkeypatch):
    assert auth_methods.get_google_client_secret() is None
    monkeypatch.setenv(auth_methods.GOOGLE_CLIENT_SECRET_ENV, "sekret")
    assert auth_methods.get_google_client_secret() == "sekret"


def test_web_redirect_needs_enabled_id_and_secret(monkeypatch):
    monkeypatch.setenv(auth_methods.GOOGLE_CONNECT_ENABLED_ENV, "true")
    monkeypatch.setenv(auth_methods.GOOGLE_CLIENT_ID_ENV, "web-client")
    # Enabled + id but no secret → the code exchange can't run → unavailable.
    assert auth_methods.is_google_web_redirect_available() is False
    monkeypatch.setenv(auth_methods.GOOGLE_CLIENT_SECRET_ENV, "web-secret")
    assert auth_methods.is_google_web_redirect_available() is True


def test_web_redirect_requires_enabled(monkeypatch):
    # Configured but the feature flag is off → unavailable.
    monkeypatch.setenv(auth_methods.GOOGLE_CLIENT_ID_ENV, "web-client")
    monkeypatch.setenv(auth_methods.GOOGLE_CLIENT_SECRET_ENV, "web-secret")
    assert auth_methods.is_google_web_redirect_available() is False
