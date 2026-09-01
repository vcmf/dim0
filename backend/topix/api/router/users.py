"""Users API Router."""
import logging

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm

from topix.api.datatypes.requests import (
    EmailVerificationRequest,
    ForgotPasswordRequest,
    GoogleDesktopSigninRequest,
    GoogleSigninRequest,
    GoogleWebRedirectSigninRequest,
    RefreshRequest,
    ResetPasswordRequest,
    UserSignupRequest,
)
from topix.api.utils.auth_methods import (
    get_google_client_id,
    get_google_desktop_client_id,
    is_google_connect_available,
    is_google_desktop_available,
    is_google_web_redirect_available,
)
from topix.api.utils.decorators import with_standard_response
from topix.api.utils.email_verification import (
    DEFAULT_RESEND_COOLDOWN_SECONDS,
    build_email_verification_url,
    compute_verification_expiry,
    generate_email_verification_token,
    get_email_verification_config,
    hash_email_verification_token,
    is_email_verification_enabled,
    send_email_verification_link,
    utc_now,
)
from topix.api.utils.google_connect import (
    exchange_desktop_code,
    exchange_web_code,
    verify_google_id_token,
)
from topix.api.utils.password_reset import (
    DEFAULT_RESET_RESEND_COOLDOWN_SECONDS,
    build_password_reset_url,
    compute_reset_expiry,
    generate_password_reset_token,
    get_password_reset_config,
    hash_password_reset_token,
    is_password_reset_enabled,
    send_password_reset_link,
)
from topix.api.utils.rate_limit.token_plan import resolve_plan_for_token
from topix.api.utils.security import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    REFRESH_TOKEN_EXPIRE_DAYS,
    Token,
    authenticate_user,
    create_access_token,
    create_refresh_token,
    decode_and_validate_token,
    get_current_user_uid,
    get_password_hash,
)
from topix.datatypes.email_verification import EmailVerificationToken
from topix.datatypes.password_reset import PasswordResetToken
from topix.datatypes.user import User
from topix.store.email_verification import EmailVerificationStore
from topix.store.password_reset import PasswordResetStore
from topix.store.user import UserStore

router = APIRouter(
    prefix="/users",
    tags=["users"],
    responses={404: {"description": "Not found"}},
)


ROTATE_REFRESH_TOKENS = True  # set False if you prefer not to rotate


async def _issue_tokens(request: Request, user: User) -> dict:
    """Issue access and refresh tokens for a signed-in user."""
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    plan = await resolve_plan_for_token(request, user.uid)
    access_token = create_access_token(
        data={
            "sub": user.uid,
            "email": user.email,
            "name": user.name,
            "username": user.username,
            "plan": plan,
        },
        expires_delta=access_token_expires,
    )
    refresh_token = create_refresh_token(
        data={"sub": user.uid},
        expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    )
    return {
        "token": Token(
            access_token=access_token,
            token_type="bearer",
            refresh_token=refresh_token
        ).model_dump(exclude_none=True)
    }


@router.get("/auth-methods")
@with_standard_response
async def get_auth_methods():
    """Return which authentication methods are currently available."""
    google_available = is_google_connect_available()
    desktop_available = is_google_desktop_available()
    web_redirect_available = is_google_web_redirect_available()
    return {
        "local": True,
        "google": google_available,
        "google_client_id": get_google_client_id() if google_available else None,
        # Web redirect (auth-code + PKCE) — available only when the web client
        # secret is configured for the server-side code exchange.
        "google_web_redirect": web_redirect_available,
        # The desktop app authorizes against its own "Desktop app" OAuth client.
        "google_desktop_client_id": get_google_desktop_client_id() if desktop_available else None,
    }


@router.post("/signin")
@with_standard_response
async def login_for_access_token(
    request: Request,
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
):
    """Signin for the user and return tokens."""
    user_store: UserStore = request.app.user_store
    user = await authenticate_user(user_store, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return await _issue_tokens(request, user)


async def _google_signin_with_payload(request: Request, payload: dict):
    """Find/create the user for a verified Google payload, then issue tokens (web + desktop)."""
    user_store: UserStore = request.app.user_store
    user = await user_store.get_user_by_google_sub(payload["sub"])
    if user is not None:
        return await _issue_tokens(request, user)

    existing_user = await user_store.get_user_by_email(payload["email"])
    if existing_user is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists. Please sign in with your existing method first.",
        )

    new_user = User(
        email=payload["email"],
        username=payload["email"],
        name=payload.get("name"),
        auth_provider="google",
        google_sub=payload["sub"],
        google_email=payload["email"],
        google_picture_url=payload.get("picture"),
        google_linked_at=utc_now(),
        email_verified_at=utc_now(),
    )
    try:
        await user_store.add_user(new_user)
    except Exception as exc:
        logging.exception("Failed to create Google user")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Error when creating user",
        ) from exc

    return await _issue_tokens(request, new_user)


@router.post("/google-signin")
@with_standard_response
async def google_signin(
    response: Response,
    request: Request,
    body: Annotated[GoogleSigninRequest, Body(description="Google sign-in token payload")],
):
    """Sign in with Google (web) — verify the GIS id_token and issue tokens."""
    if not is_google_connect_available():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Google connect is not available",
        )
    payload = verify_google_id_token(body.id_token)
    return await _google_signin_with_payload(request, payload)


@router.post("/google-signin-desktop")
@with_standard_response
async def google_signin_desktop(
    request: Request,
    body: Annotated[GoogleDesktopSigninRequest, Body(description="Desktop loopback auth code + PKCE")],
):
    """Desktop Google sign-in: exchange the loopback code (PKCE) server-side, then issue tokens."""
    if not is_google_desktop_available():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Google desktop sign-in is not available",
        )
    id_token = await exchange_desktop_code(body.code, body.code_verifier, body.redirect_uri)
    payload = verify_google_id_token(id_token, audience=get_google_desktop_client_id())
    return await _google_signin_with_payload(request, payload)


@router.post("/google-signin-web")
@with_standard_response
async def google_signin_web(
    request: Request,
    body: Annotated[GoogleWebRedirectSigninRequest, Body(description="Web redirect auth code + PKCE")],
):
    """Web Google sign-in: exchange the redirect auth code (PKCE) server-side, then issue tokens."""
    if not is_google_web_redirect_available():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Google web sign-in is not available",
        )
    id_token = await exchange_web_code(body.code, body.code_verifier, body.redirect_uri)
    payload = verify_google_id_token(id_token, audience=get_google_client_id())
    return await _google_signin_with_payload(request, payload)


@router.post("/signup")
@with_standard_response
async def create_user(
    request: Request,
    body: Annotated[UserSignupRequest, Body(description="User signup data")],
):
    """Create a user in postgres database."""
    user_store: UserStore = request.app.user_store
    pw_hash = get_password_hash(body.password)
    new_user = User(
        email=body.email,
        password_hash=pw_hash,
        name=body.name,
        username=body.username,
    )
    try:
        await user_store.add_user(new_user)
    except Exception as e:
        logging.info(e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Error when creating user",
        )

    if is_email_verification_enabled():
        email_verification_store: EmailVerificationStore = request.app.email_verification_store
        verification_config = get_email_verification_config()
        raw_token = generate_email_verification_token()
        token_hash = hash_email_verification_token(raw_token)
        now = utc_now()
        await email_verification_store.save_token(
            EmailVerificationToken(
                user_uid=new_user.uid,
                token_hash=token_hash,
                expires_at=compute_verification_expiry(now, verification_config.ttl_hours),
                created_at=now,
            )
        )
        verification_url = build_email_verification_url(verification_config.app_base_url, raw_token)
        try:
            await send_email_verification_link(
                resend_api_key=verification_config.resend_api_key,
                resend_from_email=verification_config.resend_from_email,
                to_email=new_user.email,
                verification_url=verification_url,
                ttl_hours=verification_config.ttl_hours,
            )
        except HTTPException:
            logging.exception("Failed to send verification email on signup for user %s", new_user.uid)

    return await _issue_tokens(request, new_user)


@router.post("/verify-email")
@with_standard_response
async def verify_email(
    response: Response,
    request: Request,
    body: Annotated[EmailVerificationRequest, Body(description="Email verification token payload")],
):
    """Verify user email from a verification token."""
    if not is_email_verification_enabled():
        return {"message": "Email verification is disabled"}

    email_verification_store: EmailVerificationStore = request.app.email_verification_store
    user_store: UserStore = request.app.user_store

    token_hash = hash_email_verification_token(body.token)
    token = await email_verification_store.get_active_token_by_hash(token_hash)
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired verification token",
        )

    await user_store.mark_user_email_verified(token.user_uid)
    await email_verification_store.mark_token_used(token.uid)
    return {"message": "Email verified successfully"}


@router.post("/resend-verification")
@with_standard_response
async def resend_verification_email(
    response: Response,
    request: Request,
    user_id: Annotated[str, Depends(get_current_user_uid)],
):
    """Resend verification email to the current user."""
    if not is_email_verification_enabled():
        return {"message": "Email verification is disabled"}

    user_store: UserStore = request.app.user_store
    email_verification_store: EmailVerificationStore = request.app.email_verification_store
    verification_config = get_email_verification_config()

    user = await user_store.get_user(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.email_verified_at is not None:
        return {"message": "Email already verified"}

    latest_token = await email_verification_store.get_latest_token_for_user(user.uid)
    now = utc_now()
    if latest_token and latest_token.created_at:
        elapsed = (now - latest_token.created_at).total_seconds()
        if elapsed < DEFAULT_RESEND_COOLDOWN_SECONDS:
            retry_after = max(1, int(DEFAULT_RESEND_COOLDOWN_SECONDS - elapsed))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Please wait before requesting another verification email",
                headers={"Retry-After": str(retry_after)},
            )

    raw_token = generate_email_verification_token()
    token_hash = hash_email_verification_token(raw_token)
    await email_verification_store.save_token(
        EmailVerificationToken(
            user_uid=user.uid,
            token_hash=token_hash,
            expires_at=compute_verification_expiry(now, verification_config.ttl_hours),
            created_at=now,
        )
    )
    verification_url = build_email_verification_url(verification_config.app_base_url, raw_token)
    await send_email_verification_link(
        resend_api_key=verification_config.resend_api_key,
        resend_from_email=verification_config.resend_from_email,
        to_email=user.email,
        verification_url=verification_url,
        ttl_hours=verification_config.ttl_hours,
    )
    return {"message": "Verification email sent"}


@router.get("/email-verification-status")
@with_standard_response
async def get_email_verification_status(
    response: Response,
    request: Request,
    user_id: Annotated[str, Depends(get_current_user_uid)],
):
    """Return whether verification is enabled and whether current user is verified."""
    enabled = is_email_verification_enabled()
    if not enabled:
        return {"enabled": False, "verified": True}

    user_store: UserStore = request.app.user_store
    user = await user_store.get_user(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    return {
        "enabled": True,
        "verified": user.email_verified_at is not None,
    }


@router.post("/refresh")
@with_standard_response
async def refresh_access_token(
    response: Response,
    request: Request,
    body: Annotated[RefreshRequest, Body(description="Refresh token payload")],
):
    """Exchange a valid refresh token for a new access token.

    Optionally rotate refresh token.
    """
    # 1) Validate refresh token (type + exp + signature)
    payload = decode_and_validate_token(body.refresh_token, expected_type="refresh")
    user_uid = payload.get("sub")
    if not user_uid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    # (optional) Check the user still exists / active
    user_store: UserStore = request.app.user_store
    user = await user_store.get_user(user_uid)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    # Refresh-token revocation gate. After password reset we set password_changed_at;
    # any token issued before that timestamp must be rejected to invalidate stolen sessions.
    if user.password_changed_at is not None:
        iat_raw = payload.get("iat")
        if iat_raw is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token revoked")
        iat_dt = datetime.fromtimestamp(int(iat_raw), tz=timezone.utc).replace(tzinfo=None)
        if iat_dt < user.password_changed_at:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token revoked")

    # 2) Issue new access token (short-lived)
    plan = await resolve_plan_for_token(request, user.uid)
    access_token = create_access_token(
        data={
            "sub": user.uid,
            "email": user.email,
            "name": user.name,
            "username": user.username,
            "plan": plan,
        },
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )

    # 3) Optionally rotate refresh token (recommended)
    new_refresh = None
    if ROTATE_REFRESH_TOKENS:
        new_refresh = create_refresh_token(
            data={"sub": user.uid},
            expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        )

    return {
        "token": Token(
            access_token=access_token,
            token_type="bearer",
            refresh_token=new_refresh
        ).model_dump(exclude_none=True)
    }


@router.delete("/")
@with_standard_response
async def delete_user(
    request: Request,
    user_id: Annotated[str, Depends(get_current_user_uid)],
):
    """Delete a user by its ID."""
    user_store: UserStore = request.app.user_store
    return await user_store.delete_user(user_id, hard_delete=True)


@router.get("/password-reset-status")
@with_standard_response
async def get_password_reset_status():
    """Return whether the password reset flow is enabled."""
    return {"enabled": is_password_reset_enabled()}


@router.post("/forgot-password")
@with_standard_response
async def forgot_password(
    response: Response,
    request: Request,
    body: Annotated[ForgotPasswordRequest, Body(description="Email to send a password reset link to")],
):
    """Send a password reset email if the address belongs to a local-credential account.

    Always returns the same generic 200 response to prevent email enumeration.
    Silently no-ops for unknown emails, Google-only accounts, or when reset is disabled.
    """
    generic_response = {"message": "If an account exists, a password reset link has been sent."}
    if not is_password_reset_enabled():
        return generic_response

    email = (body.email or "").strip()
    if not email:
        return generic_response

    user_store: UserStore = request.app.user_store
    password_reset_store: PasswordResetStore = request.app.password_reset_store

    user = await user_store.get_user_by_email(email)
    if not user or not user.password_hash:
        # Unknown email or Google-only account: silently no-op.
        return generic_response

    reset_config = get_password_reset_config()
    now = utc_now()

    latest_token = await password_reset_store.get_latest_token_for_user(user.uid)
    if latest_token and latest_token.created_at:
        elapsed = (now - latest_token.created_at).total_seconds()
        if elapsed < DEFAULT_RESET_RESEND_COOLDOWN_SECONDS:
            # Still inside cooldown: do not regenerate and do not reveal anything.
            return generic_response

    raw_token = generate_password_reset_token()
    token_hash = hash_password_reset_token(raw_token)
    await password_reset_store.save_token(
        PasswordResetToken(
            user_uid=user.uid,
            token_hash=token_hash,
            expires_at=compute_reset_expiry(now, reset_config.ttl_hours),
            created_at=now,
        )
    )
    reset_url = build_password_reset_url(reset_config.app_base_url, raw_token)
    try:
        await send_password_reset_link(
            resend_api_key=reset_config.resend_api_key,
            resend_from_email=reset_config.resend_from_email,
            to_email=user.email,
            reset_url=reset_url,
            ttl_hours=reset_config.ttl_hours,
        )
    except HTTPException:
        logging.exception("Failed to send password reset email for user %s", user.uid)

    return generic_response


@router.post("/reset-password")
@with_standard_response
async def reset_password(
    response: Response,
    request: Request,
    body: Annotated[ResetPasswordRequest, Body(description="Reset token + new password payload")],
):
    """Consume a reset token and update the user's password.

    Sets password_changed_at so existing refresh tokens become unusable on next refresh.
    """
    if not is_password_reset_enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password reset is disabled",
        )

    if not body.new_password or len(body.new_password) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must be at least 8 characters",
        )

    password_reset_store: PasswordResetStore = request.app.password_reset_store
    user_store: UserStore = request.app.user_store

    token_hash = hash_password_reset_token(body.token)
    token = await password_reset_store.get_active_token_by_hash(token_hash)
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token",
        )

    pw_hash = get_password_hash(body.new_password)
    await user_store.update_user(
        token.user_uid,
        {"password_hash": pw_hash, "password_changed_at": utc_now()},
    )
    await password_reset_store.mark_token_used(token.uid)
    return {"message": "Password reset successfully"}
