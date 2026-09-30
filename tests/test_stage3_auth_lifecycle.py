import asyncio
import os
import secrets
from datetime import datetime, timedelta, timezone
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import select

from app.main import app
from app.core.config import settings
from app.core.security import create_jwt_token, verify_jwt_token
from app.db.database import Base, get_db
from app.db.models import User, AuthorizationCode, RefreshToken, RevokedToken
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService
from app.services.token_service import TokenService

TEST_DATABASE_URL = "sqlite+aiosqlite:////tmp/test_ha_stage3.db"
test_engine = create_async_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
db_session_test_maker = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)

@pytest.fixture(autouse=True, scope="function")
def setup_test_db():
    import app.db.database
    import app.api.websocket
    orig_session_maker = app.db.database.async_session_maker
    orig_ws_maker = getattr(app.api.websocket, "async_session_maker", None)

    app.db.database.async_session_maker = db_session_test_maker
    app.api.websocket.async_session_maker = db_session_test_maker
    from app.main import app as fastapi_app
    fastapi_app.dependency_overrides[get_db] = override_get_db

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def create_tables():
        async with test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

    async def drop_tables():
        async with test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)

    loop.run_until_complete(create_tables())
    yield
    loop.run_until_complete(drop_tables())
    loop.run_until_complete(test_engine.dispose())
    loop.close()

    app.db.database.async_session_maker = orig_session_maker
    if orig_ws_maker:
        app.api.websocket.async_session_maker = orig_ws_maker

    for db_file in ["/tmp/test_ha_stage3.db", "/tmp/test_ha_stage3.db-shm", "/tmp/test_ha_stage3.db-wal"]:
        if os.path.exists(db_file):
            try:
                os.remove(db_file)
            except Exception:
                pass

async def override_get_db():
    async with db_session_test_maker() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

app.dependency_overrides[get_db] = override_get_db
client = TestClient(app)

@pytest.mark.asyncio
async def test_access_token_creation_and_validation():
    """Verify JWT access token structure, expiration, and payload binding."""
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="auth_user1", password="password123", display_name="Auth User 1"))
        user_id = user.id

    token = create_jwt_token(data={"sub": str(user_id), "typ": "access"})
    payload = verify_jwt_token(token)
    assert payload is not None
    assert payload["sub"] == str(user_id)
    assert payload["typ"] == "access"
    assert "exp" in payload
    assert "iat" in payload
    assert "jti" in payload

    # Test HTTP header authentication with valid token
    res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert res.json()["username"] == "auth_user1"

    # Test expired token
    expired_token = create_jwt_token(data={"sub": str(user_id), "typ": "access"}, expires_delta=timedelta(seconds=-10))
    res_exp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired_token}"})
    assert res_exp.status_code == 401

@pytest.mark.asyncio
async def test_access_token_revocation():
    """Verify revoking an access token immediately invalidates HTTP and WebSocket requests."""
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="revoke_user", password="password123", display_name="Revoke User"))
        user_id = user.id

    token = create_jwt_token(data={"sub": str(user_id), "typ": "access"})
    # Initially valid
    res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200

    # Revoke access token via /auth/revoke
    rev_res = client.post("/auth/revoke", data={"token": token, "token_type_hint": "access_token"})
    assert rev_res.status_code == 200

    # Subsequent HTTP request with revoked token must fail with 401
    res_after = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert res_after.status_code == 401
    assert "revoked" in res_after.json()["detail"].lower()

    # WebSocket authentication with revoked token must fail with auth_invalid
    with client.websocket_connect("/api/websocket") as ws:
        chal = ws.receive_json()
        assert chal["type"] == "auth_required"
        ws.send_json({"type": "auth", "access_token": token})
        resp = ws.receive_json()
        assert resp["type"] == "auth_invalid"
        assert "revoked" in resp["message"].lower()

@pytest.mark.asyncio
async def test_refresh_token_lifecycle_and_revocation():
    """Verify refresh token creation, token exchange, client_id binding, and revocation."""
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="ref_user", password="password123", display_name="Refresh User"))
        user_id = user.id

    client_id = "https://home-assistant.io/android"

    # Create authorization code and exchange for tokens
    code_res = client.post(
        "/auth/login_submit",
        data={
            "username": "ref_user",
            "password": "password123",
            "client_id": client_id,
            "redirect_uri": "homeassistant://auth-callback",
            "response_type": "code",
            "state": "state_123"
        },
        follow_redirects=False
    )
    assert code_res.status_code == 302
    loc = code_res.headers["location"]
    code = loc.split("code=")[1].split("&")[0]

    # Token exchange
    token_res = client.post("/auth/token", data={
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "redirect_uri": "homeassistant://auth-callback"
    })
    assert token_res.status_code == 200
    token_data = token_res.json()
    access_token = token_data["access_token"]
    refresh_token = token_data["refresh_token"]

    # 1. Use refresh token to get a new access token
    refresh_res = client.post("/auth/token", data={
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token
    })
    assert refresh_res.status_code == 200
    new_access_token = refresh_res.json()["access_token"]
    assert new_access_token != access_token

    # 2. Client ID mismatch must be rejected
    mismatch_res = client.post("/auth/token", data={
        "grant_type": "refresh_token",
        "client_id": "https://different-client.com",
        "refresh_token": refresh_token
    })
    assert mismatch_res.status_code == 400

    # 3. Revoke refresh token via action=revoke on /auth/token
    revoke_res = client.post("/auth/token", data={
        "action": "revoke",
        "token": refresh_token,
        "client_id": client_id
    })
    assert revoke_res.status_code == 200

    # 4. Attempting to use revoked refresh token must be rejected
    after_revoke_res = client.post("/auth/token", data={
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token
    })
    assert after_revoke_res.status_code == 400

@pytest.mark.asyncio
async def test_authorization_code_single_use_and_redirect_validation():
    """Verify authorization code single-use replay protection and redirect_uri binding."""
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="code_user", password="password123", display_name="Code User"))
        user_id = user.id

    client_id = "https://home-assistant.io/android"
    redirect_uri = "homeassistant://auth-callback"

    # Issue auth code
    async with db_session_test_maker() as db:
        raw_code = await TokenService.create_authorization_code(
            db=db,
            user_id=user_id,
            client_id=client_id,
            redirect_uri=redirect_uri
        )

    # Mismatched redirect_uri must fail
    bad_uri_res = client.post("/auth/token", data={
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": raw_code,
        "redirect_uri": "https://malicious-site.com/callback"
    })
    assert bad_uri_res.status_code == 400

    # Mismatched client_id must fail
    bad_client_res = client.post("/auth/token", data={
        "grant_type": "authorization_code",
        "client_id": "https://malicious-client.com",
        "code": raw_code,
        "redirect_uri": redirect_uri
    })
    assert bad_client_res.status_code == 400

    # Successful exchange with matching parameters
    good_res = client.post("/auth/token", data={
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": raw_code,
        "redirect_uri": redirect_uri
    })
    assert good_res.status_code == 200

    # Replay of consumed code MUST be rejected
    replay_res = client.post("/auth/token", data={
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": raw_code,
        "redirect_uri": redirect_uri
    })
    assert replay_res.status_code == 400

@pytest.mark.asyncio
async def test_logout_endpoint_flow():
    """Verify /api/auth/logout endpoint invalidates both access and refresh tokens."""
    # Register and login via web API
    client.post("/api/setup/register", json={
        "username": "logout_user",
        "password": "password123",
        "display_name": "Logout User"
    })
    login_res = client.post("/api/auth/login", json={
        "username": "logout_user",
        "password": "password123"
    })
    assert login_res.status_code == 200
    token_data = login_res.json()
    access_token = token_data["access_token"]
    refresh_token = token_data["refresh_token"]

    # Verify session works
    me_res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert me_res.status_code == 200

    # Call /api/auth/logout
    logout_res = client.post(
        "/api/auth/logout",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"refresh_token": refresh_token}
    )
    assert logout_res.status_code == 200
    assert logout_res.json()["success"] is True

    # Access token is now revoked
    me_after = client.get("/api/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert me_after.status_code == 401

    # Refresh token is now revoked
    ref_after = client.post("/auth/token", data={
        "grant_type": "refresh_token",
        "client_id": "web_ui",
        "refresh_token": refresh_token
    })
    assert ref_after.status_code == 400
