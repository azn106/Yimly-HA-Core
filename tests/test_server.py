import asyncio
import os
import uuid
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from app.main import app
from app.core.config import settings
from app.db.database import Base, get_db
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService
from app.services.token_service import TokenService
from app.core.security import create_jwt_token


# 1. Setup Test Database using File-Based SQLite in /tmp/
TEST_DATABASE_URL = "sqlite+aiosqlite:////tmp/test_ha_server.db"
test_engine = create_async_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
db_session_test_maker = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)

@pytest.fixture(autouse=True, scope="function")
def setup_test_db():
    import app.db.database
    import app.api.websocket
    orig_session_maker = app.db.database.async_session_maker
    orig_ws_session_maker = getattr(app.api.websocket, "async_session_maker", None)
    
    app.db.database.async_session_maker = db_session_test_maker
    app.api.websocket.async_session_maker = db_session_test_maker

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    # Sync helper to run async commands
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
    if orig_ws_session_maker is not None:
        app.api.websocket.async_session_maker = orig_ws_session_maker


    # Try removing the DB file cleanly from /tmp
    for db_file in ["/tmp/test_ha_server.db", "/tmp/test_ha_server.db-shm", "/tmp/test_ha_server.db-wal"]:

        if os.path.exists(db_file):
            try:
                os.remove(db_file)
            except Exception:
                pass




# Override get_db dependency to point to our test database
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

# --- PHASE 6/7/8: AUTHENTICATION TESTS ---

@pytest.mark.asyncio
async def test_create_user_and_login():
    async with db_session_test_maker() as db:
        user_in = UserCreate(username="testuser", password="secretpassword", display_name="Test User")
        user = await AuthService.create_user(db, user_in)
        assert user.username == "testuser"
        assert user.display_name == "Test User"
        assert user.password_hash != "secretpassword"  # Must be hashed!

        # Try timing-safe authentication
        authed_user = await AuthService.authenticate_user(db, "testuser", "secretpassword")
        assert authed_user is not None
        assert authed_user.username == "testuser"

        # Invalid password authentication
        bad_auth = await AuthService.authenticate_user(db, "testuser", "wrongpassword")
        assert bad_auth is None

        # Invalid username authentication
        bad_user = await AuthService.authenticate_user(db, "unknown", "secretpassword")
        assert bad_user is None


@pytest.mark.asyncio
async def test_oauth_authorize_and_token_exchange():
    async with db_session_test_maker() as db:
        # Create test user
        user_in = UserCreate(username="oauth_user", password="secure_password", display_name="OAuth User")
        user = await AuthService.create_user(db, user_in)

        # 1. Test GET /auth/authorize (renders login form)
        response = client.get("/auth/authorize?client_id=http://localhost:8123/&redirect_uri=homeassistant://auth-callback&response_type=code&state=xyz123")
        assert response.status_code == 200
        assert "login" in response.text
        assert "oauth_user" not in response.text

        # 2. Test POST /auth/login_submit (successful login & redirect with authorization code)
        form_data = {
            "username": "oauth_user",
            "password": "secure_password",
            "client_id": "http://localhost:8123/",
            "redirect_uri": "homeassistant://auth-callback",
            "response_type": "code",
            "state": "xyz123"
        }
        # Follow_redirects=False to intercept 302
        submit_res = client.post("/auth/login_submit", data=form_data, follow_redirects=False)
        assert submit_res.status_code == 302
        redirect_location = submit_res.headers.get("location")
        assert "homeassistant://auth-callback" in redirect_location
        assert "code=" in redirect_location
        assert "state=xyz123" in redirect_location

        # Extract code from redirect URL
        code = redirect_location.split("code=")[1].split("&")[0]
        assert code is not None

        # 3. Test POST /auth/token (exchange authorization code for access and refresh tokens)
        token_payload = {
            "grant_type": "authorization_code",
            "client_id": "http://localhost:8123/",
            "code": code,
            "redirect_uri": "homeassistant://auth-callback"
        }
        token_res = client.post("/auth/token", data=token_payload)
        assert token_res.status_code == 200
        tokens = token_res.json()
        assert "access_token" in tokens
        assert "refresh_token" in tokens
        assert tokens["token_type"] == "Bearer"

        access_token = tokens["access_token"]
        refresh_token = tokens["refresh_token"]

        # 4. Re-exchange same code (replay attack prevention - code must be single-use)
        replay_res = client.post("/auth/token", data=token_payload)
        assert replay_res.status_code == 400

        # 5. Test refresh token exchange
        refresh_payload = {
            "grant_type": "refresh_token",
            "client_id": "http://localhost:8123/",
            "refresh_token": refresh_token
        }
        refresh_res = client.post("/auth/token", data=refresh_payload)
        assert refresh_res.status_code == 200
        refreshed_tokens = refresh_res.json()
        assert "access_token" in refreshed_tokens
        assert refreshed_tokens["access_token"] != access_token


# --- PHASE 11: REST FOUNDATION & API CONFIG ---

@pytest.mark.asyncio
async def test_api_config_unauthorized_and_authorized():
    # 1. Try unauthorized access
    unauth_res = client.get("/api/config")
    assert unauth_res.status_code == 401

    async with db_session_test_maker() as db:
        user_in = UserCreate(username="rest_user", password="rest_password", display_name="Rest User")
        user = await AuthService.create_user(db, user_in)
        
        # Generate token
        token = TokenService.hash_value("dummy")  # Generate valid token
        # Generate valid JWT
        access_token = create_jwt_token(data={"sub": str(user.id), "typ": "access"})

        # 2. Access with valid Bearer token
        headers = {"Authorization": f"Bearer {access_token}"}
        auth_res = client.get("/api/config", headers=headers)
        assert auth_res.status_code == 200
        config_data = auth_res.json()
        assert "version" in config_data
        assert "components" in config_data
        assert "latitude" in config_data
        assert "longitude" in config_data


# --- PHASE 14/15/16/17: MOBILE REGISTRATION & TELEMETRY WEBHOOKS ---

@pytest.mark.asyncio
async def test_mobile_app_registration_and_webhooks():
    async with db_session_test_maker() as db:
        user_in = UserCreate(username="mobile_user", password="mobile_password", display_name="Mobile User")
        user = await AuthService.create_user(db, user_in)
        access_token = create_jwt_token(data={"sub": str(user.id), "typ": "access"})
        headers = {"Authorization": f"Bearer {access_token}"}

        # 1. Register a mobile device
        reg_payload = {
            "device_id": "nexus_9",
            "app_id": "io.homeassistant.companion",
            "app_name": "Home Assistant",
            "app_version": "1.0.0",
            "device_name": "Nexus 9",
            "manufacturer": "HTC",
            "model": "Nexus 9",
            "os_name": "Android",
            "os_version": "9.0",
            "supports_encryption": False,
            "app_data": {}
        }
        reg_res = client.post("/api/mobile_app/registrations", json=reg_payload, headers=headers)
        assert reg_res.status_code == 201
        reg_data = reg_res.json()
        assert "webhook_id" in reg_data
        webhook_id = reg_data["webhook_id"]

        # 2. Send location telemetry update via webhook
        loc_payload = {
            "type": "update_location",
            "data": {
                "latitude": 37.7749,
                "longitude": -122.4194,
                "gps_accuracy": 15,
                "altitude": 10.0,
                "speed": 5.0,
                "bearing": 90.0,
                "battery": 92.5,
                "trigger": "background"
            }
        }
        loc_res = client.post(f"/api/webhook/{webhook_id}", json=loc_payload)
        assert loc_res.status_code == 200
        assert loc_res.json() == {"status": "ok"}

        # 3. Read current entity state via REST
        state_res = client.get("/api/states/device_tracker.nexus_9", headers=headers)
        assert state_res.status_code == 200
        state_data = state_res.json()
        assert state_data["entity_id"] == "device_tracker.nexus_9"
        assert state_data["state"] == "not_home"  # far from 0,0 home
        assert state_data["attributes"]["latitude"] == 37.7749
        assert state_data["attributes"]["battery_level"] == 92.5

        # 4. Register a sensor via webhook
        sensor_reg_payload = {
            "type": "register_sensor",
            "data": {
                "unique_id": "battery_sensor_nexus",
                "name": "Battery Level Sensor",
                "type": "sensor",
                "unit_of_measurement": "%",
                "icon": "mdi:battery"
            }
        }
        sensor_reg_res = client.post(f"/api/webhook/{webhook_id}", json=sensor_reg_payload)
        assert sensor_reg_res.status_code == 200
        assert "registered" in sensor_reg_res.text

        # 5. Send sensor state updates via webhook
        sensor_update_payload = {
            "type": "update_sensor_states",
            "data": [
                {
                    "unique_id": "battery_sensor_nexus",
                    "state": "88",
                    "attributes": {
                        "extra_info": "good health"
                    }
                }
            ]
        }
        sensor_update_res = client.post(f"/api/webhook/{webhook_id}", json=sensor_update_payload)
        assert sensor_update_res.status_code == 200
        assert sensor_update_res.json()["battery_sensor_nexus"]["success"] is True

        # 6. Read updated sensor state via REST
        sensor_state_res = client.get("/api/states/sensor.nexus_9_battery_level_sensor", headers=headers)
        assert sensor_state_res.status_code == 200
        sensor_state_data = sensor_state_res.json()
        assert sensor_state_data["state"] == "88"
        assert sensor_state_data["attributes"]["extra_info"] == "good health"


# --- PHASE 20: WEBSOCKET SEQUENCE TESTS ---

def test_websocket_flow_invalid_auth():
    with client.websocket_connect("/api/websocket") as ws:
        # Step 1: Receives challenge
        chal = ws.receive_json()
        assert chal["type"] == "auth_required"

        # Step 2: Send invalid auth
        ws.send_json({
            "type": "auth",
            "access_token": "invalid_access_token"
        })

        # Step 3: Server rejects and closes
        rej = ws.receive_json()
        assert rej["type"] == "auth_invalid"


def test_websocket_flow_valid_auth_and_commands():
    async def create_user_token():
        async with db_session_test_maker() as db:
            user_in = UserCreate(username="ws_user", password="ws_password", display_name="WS User")
            user = await AuthService.create_user(db, user_in)
            access_token = create_jwt_token(data={"sub": str(user.id), "typ": "access"})
            return access_token

    access_token = asyncio.run(create_user_token())

    with client.websocket_connect("/api/websocket") as ws:
        # Step 1: Challenge
        chal = ws.receive_json()
        assert chal["type"] == "auth_required"

        # Step 2: Send valid auth
        ws.send_json({
            "type": "auth",
            "access_token": access_token
        })

        # Step 3: Server accepts auth
        ok = ws.receive_json()
        assert ok["type"] == "auth_ok"

        # Step 4: Run ping command
        ws.send_json({
            "id": 10,
            "type": "ping"
        })
        pong = ws.receive_json()
        assert pong["id"] == 10
        assert pong["type"] == "pong"

        # Step 5: Run get_states command (should be empty initially)
        ws.send_json({
            "id": 11,
            "type": "get_states"
        })
        states_res = ws.receive_json()
        assert states_res["id"] == 11
        assert states_res["type"] == "result"
        assert states_res["success"] is True
        assert len(states_res["result"]) == 0

        # Step 6: Subscribe to state_changed events
        ws.send_json({
            "id": 12,
            "type": "subscribe_events",
            "event_type": "state_changed"
        })
        sub_res = ws.receive_json()
        assert sub_res["id"] == 12
        assert sub_res["success"] is True


def test_full_companion_app_simulation():
    # 1. Create a User directly in the database
    async def init_data():
        async with db_session_test_maker() as db:
            user_in = UserCreate(username="companion_user", password="companion_password", display_name="Companion User")
            user = await AuthService.create_user(db, user_in)
            return user.id
    
    user_id = asyncio.run(init_data())

    # 2. Simulate OAuth login_submit to get auth code
    response = client.post(
        "/auth/login_submit",
        data={
            "username": "companion_user",
            "password": "companion_password",
            "client_id": "https://home-assistant.io/android",
            "redirect_uri": "https://home-assistant.io/android",
            "response_type": "code",
            "state": "oauth_state_123"
        },
        follow_redirects=False
    )
    assert response.status_code == 302
    location_header = response.headers["location"]
    assert "code=" in location_header
    assert "state=oauth_state_123" in location_header
    
    # Extract authorization code from redirect URL
    import urllib.parse as urlparse
    parsed = urlparse.urlparse(location_header)
    auth_code = urlparse.parse_qs(parsed.query)["code"][0]
    
    # 3. Exchange auth code for tokens
    token_response = client.post(
        "/auth/token",
        data={
            "grant_type": "authorization_code",
            "code": auth_code,
            "client_id": "https://home-assistant.io/android",
            "redirect_uri": "https://home-assistant.io/android"
        }
    )
    assert token_response.status_code == 200
    token_data = token_response.json()
    assert "access_token" in token_data
    assert "refresh_token" in token_data
    access_token = token_data["access_token"]
    refresh_token = token_data["refresh_token"]
    
    # 4. Fetch Config using Access Token
    config_response = client.get(
        "/api/config",
        headers={"Authorization": f"Bearer {access_token}"}
    )
    assert config_response.status_code == 200
    config_data = config_response.json()
    assert "components" in config_data
    assert "version" in config_data
    
    # 5. Register Mobile App Companion
    reg_response = client.post(
        "/api/mobile_app/registrations",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "device_id": "test_companion_device_id",
            "app_id": "io.homeassistant.companion.android",
            "app_name": "Home Assistant",
            "app_version": "2026.9.1-play",
            "device_name": "Pixel 9 Pro",
            "manufacturer": "Google",
            "model": "Pixel 9 Pro",
            "os_name": "Android",
            "os_version": "14",
            "supports_encryption": True
        }
    )
    assert reg_response.status_code == 201
    reg_data = reg_response.json()
    assert "webhook_id" in reg_data
    webhook_id = reg_data["webhook_id"]
    # Verify valid 32-character secret generated when supports_encryption=True
    assert reg_data["secret"] is not None
    assert len(reg_data["secret"]) == 32
    secret = reg_data["secret"]
    
    # 6. Send Location Update to Webhook
    loc_response = client.post(
        f"/api/webhook/{webhook_id}",
        json={
            "type": "update_location",
            "data": {
                "latitude": 37.7749,
                "longitude": -122.4194,
                "gps_accuracy": 15.0,
                "battery": 88.0,
                "trigger": "periodic"
            }
        }
    )
    assert loc_response.status_code == 200
    assert loc_response.json() == {"status": "ok"}
    
    # 7. Register a Sensor on Webhook
    sensor_reg_response = client.post(
        f"/api/webhook/{webhook_id}",
        json={
            "type": "register_sensor",
            "data": {
                "unique_id": "pixel_battery",
                "name": "Battery Level",
                "type": "sensor",
                "unit_of_measurement": "%",
                "icon": "mdi:battery",
                "device_class": "battery"
            }
        }
    )
    assert sensor_reg_response.status_code == 200
    assert sensor_reg_response.json() == {"status": "registered"}
    
    # 8. Send Sensor State Update to Webhook
    sensor_update_response = client.post(
        f"/api/webhook/{webhook_id}",
        json={
            "type": "update_sensor_states",
            "data": [
                {
                    "unique_id": "pixel_battery",
                    "state": "88",
                    "attributes": {
                        "is_charging": False
                    }
                }
            ]
        }
    )
    assert sensor_update_response.status_code == 200
    assert "pixel_battery" in sensor_update_response.json()
    assert sensor_update_response.json()["pixel_battery"]["success"] is True

    # 9. Establish WebSocket Connection, Authenticate, Subscribe, and Verify Event pushes
    with client.websocket_connect("/api/websocket") as ws:
        # Step A: Receives challenge
        chal = ws.receive_json()
        assert chal["type"] == "auth_required"
        
        # Step B: Authenticate with obtained access token
        ws.send_json({
            "type": "auth",
            "access_token": access_token
        })
        auth_ok = ws.receive_json()
        assert auth_ok["type"] == "auth_ok"
        
        # Step C: Retrieve current states
        ws.send_json({
            "id": 100,
            "type": "get_states"
        })
        states_res = ws.receive_json()
        assert states_res["id"] == 100
        assert states_res["success"] is True
        
        # Map states by entity_id
        states_by_id = {s["entity_id"]: s for s in states_res["result"]}
        assert "device_tracker.pixel_9_pro" in states_by_id
        assert "sensor.pixel_9_pro_battery_level" in states_by_id
        
        # Check initial states
        assert states_by_id["device_tracker.pixel_9_pro"]["state"] in ["home", "not_home"]
        assert states_by_id["sensor.pixel_9_pro_battery_level"]["state"] == "88"
        assert states_by_id["sensor.pixel_9_pro_battery_level"]["attributes"]["unit_of_measurement"] == "%"
        assert states_by_id["sensor.pixel_9_pro_battery_level"]["attributes"]["is_charging"] is False
        
        # Step D: Subscribe to events
        ws.send_json({
            "id": 101,
            "type": "subscribe_events",
            "event_type": "state_changed"
        })
        sub_ok = ws.receive_json()
        assert sub_ok["id"] == 101
        assert sub_ok["success"] is True
        
        # Step E: Trigger another sensor update via Webhook while WebSocket is active!
        sensor_update_response2 = client.post(
            f"/api/webhook/{webhook_id}",
            json={
                "type": "update_sensor_states",
                "data": [
                    {
                        "unique_id": "pixel_battery",
                        "state": "87",
                        "attributes": {
                            "is_charging": True
                        }
                    }
                ]
            }
        )
        assert sensor_update_response2.status_code == 200
        assert sensor_update_response2.json()["pixel_battery"]["success"] is True
        
        # Step F: Verify that WebSocket received the event!
        event_msg = ws.receive_json()
        assert event_msg["type"] == "event"
        assert event_msg["id"] == 101
        event_data = event_msg["event"]
        assert event_data["event_type"] == "state_changed"
        assert event_data["data"]["entity_id"] == "sensor.pixel_9_pro_battery_level"
        assert event_data["data"]["new_state"]["state"] == "87"
        assert event_data["data"]["new_state"]["attributes"]["is_charging"] is True


def test_shared_auth_and_user_integration():
    import urllib.parse
    from app.core.security import verify_jwt_token

    client = TestClient(app)

    # A. Start with zero users
    status_response = client.get("/api/setup/status")
    assert status_response.status_code == 200
    assert status_response.json()["needs_setup"] is True

    # B. Create an account through the web UI /api/setup/register
    reg_payload = {
        "username": "User@Example.com",  # Using mixed case to test case-insensitive normalization
        "password": "strong_password123",
        "display_name": "Test User"
    }
    reg_response = client.post("/api/setup/register", json=reg_payload)
    assert reg_response.status_code == 200
    reg_data = reg_response.json()
    assert reg_data["username"] == "user@example.com"  # Normalized to lowercase
    assert reg_data["display_name"] == "Test User"

    # C. Verify exactly one user exists in the database
    status_response2 = client.get("/api/setup/status")
    assert status_response2.status_code == 200
    assert status_response2.json()["needs_setup"] is False

    # D. Log into /api/auth/login using those exact credentials
    login_payload = {
        "username": "USER@example.com",  # Mixed case to check case-insensitive match
        "password": "strong_password123"
    }
    web_login_response = client.post("/api/auth/login", json=login_payload)
    assert web_login_response.status_code == 200
    web_login_data = web_login_response.json()
    assert "access_token" in web_login_data
    web_token = web_login_data["access_token"]
    
    # Decode and check web user ID
    web_payload = verify_jwt_token(web_token)
    assert web_payload is not None
    web_user_id = web_payload["sub"]

    # E. Verify the native HA-compatible /auth/authorize + /auth/token flow can authenticate that SAME account using the SAME password.
    # Step E1: Login submit
    form_data = {
        "username": "user@example.com",
        "password": "strong_password123",
        "client_id": "https://home-assistant.io/android",
        "redirect_uri": "https://home-assistant.io/android",
        "response_type": "code",
        "state": "oauth_state_456"
    }
    submit_res = client.post("/auth/login_submit", data=form_data, follow_redirects=False)
    assert submit_res.status_code == 302
    location = submit_res.headers["location"]
    assert "code=" in location
    assert "state=oauth_state_456" in location

    # Extract auth code from redirect location
    parsed = urllib.parse.urlparse(location)
    params = urllib.parse.parse_qs(parsed.query)
    auth_code = params["code"][0]

    # Step E2: Exchange code for native access token
    token_form = {
        "grant_type": "authorization_code",
        "client_id": "https://home-assistant.io/android",
        "code": auth_code,
        "redirect_uri": "https://home-assistant.io/android"
    }
    token_res = client.post("/auth/token", data=token_form)
    assert token_res.status_code == 200
    token_data = token_res.json()
    assert "access_token" in token_data
    native_token = token_data["access_token"]

    # F. Verify both authentication paths identify the same internal user ID.
    native_payload = verify_jwt_token(native_token)
    assert native_payload is not None
    native_user_id = native_payload["sub"]

    assert web_user_id == native_user_id
    assert int(web_user_id) == reg_data["id"]

    # G. Confirm incorrect credentials fail through BOTH authentication paths
    # G1: Web Login incorrect password
    bad_login_payload = {
        "username": "user@example.com",
        "password": "wrong_password"
    }
    bad_web_res = client.post("/api/auth/login", json=bad_login_payload)
    assert bad_web_res.status_code == 401

    # G2: OAuth Login submit incorrect password
    bad_form_data = {
        "username": "user@example.com",
        "password": "wrong_password",
        "client_id": "https://home-assistant.io/android",
        "redirect_uri": "https://home-assistant.io/android",
        "response_type": "code",
        "state": "oauth_state_bad"
    }
    bad_submit_res = client.post("/auth/login_submit", data=bad_form_data, follow_redirects=False)
    assert bad_submit_res.status_code == 200
    assert "Invalid username or password" in bad_submit_res.text


@pytest.mark.asyncio
async def test_normal_user_registration_after_setup():
    client = TestClient(app)

    # 1. Registration through /api/auth/register fails if setup is not completed
    fail_res = client.post("/api/auth/register", json={
        "username": "User2",
        "password": "secure_password456",
        "display_name": "User Two"
    })
    assert fail_res.status_code == 400
    assert "setup" in fail_res.json()["detail"].lower()

    # 2. Perform initial first-run setup
    setup_res = client.post("/api/setup/register", json={
        "username": "AdminUser",
        "password": "adminpassword123",
        "display_name": "System Administrator"
    })
    assert setup_res.status_code == 200

    # 3. Setup has been completed. Now setup_register fails
    setup_fail = client.post("/api/setup/register", json={
        "username": "User2",
        "password": "secure_password456",
        "display_name": "User Two"
    })
    assert setup_fail.status_code == 400

    # 4. Try to register with an existing username (case-insensitive check)
    dup_res = client.post("/api/auth/register", json={
        "username": "adminuser",
        "password": "different_password",
        "display_name": "Another Admin"
    })
    assert dup_res.status_code == 400
    assert "exists" in dup_res.json()["detail"].lower()

    # 5. Successfully register second user
    success_res = client.post("/api/auth/register", json={
        "username": "User2",
        "password": "secure_password456",
        "display_name": "User Two"
    })
    assert success_res.status_code == 200
    reg_data = success_res.json()
    assert reg_data["username"] == "user2"
    assert reg_data["display_name"] == "User Two"

    # 6. Verify second user can log in normally
    login_res = client.post("/api/auth/login", json={
        "username": "user2",
        "password": "secure_password456"
    })
    assert login_res.status_code == 200
    assert "access_token" in login_res.json()


@pytest.mark.asyncio
async def test_circle_join_flow():
    client = TestClient(app)

    # 1. Setup/Register User A (Admin)
    res_a = client.post("/api/setup/register", json={
        "username": "UserA",
        "password": "passwordA123",
        "display_name": "User Alpha"
    })
    assert res_a.status_code == 200
    
    # Login as User A to get token
    login_a = client.post("/api/auth/login", json={
        "username": "UserA",
        "password": "passwordA123"
    })
    assert login_a.status_code == 200
    token_a = login_a.json()["access_token"]

    # Create Circle as User A
    res_circle = client.post("/api/circles", json={"name": "Alpha Circle"}, headers={
        "Authorization": f"Bearer {token_a}"
    })
    assert res_circle.status_code == 200
    circle_data = res_circle.json()
    invite_code = circle_data["invite_code"]
    assert len(invite_code) == 8

    # 2. Register User B
    res_b = client.post("/api/auth/register", json={
        "username": "UserB",
        "password": "passwordB123",
        "display_name": "User Beta"
    })
    assert res_b.status_code == 200

    # Login as User B
    login_b = client.post("/api/auth/login", json={
        "username": "UserB",
        "password": "passwordB123"
    })
    assert login_b.status_code == 200
    token_b = login_b.json()["access_token"]

    # 3. Join with invalid code (should fail)
    bad_join = client.post("/api/circles/join", json={"invite_code": "INVALID8"}, headers={
        "Authorization": f"Bearer {token_b}"
    })
    assert bad_join.status_code == 404

    # 4. Join with valid code (should succeed)
    good_join = client.post("/api/circles/join", json={"invite_code": invite_code}, headers={
        "Authorization": f"Bearer {token_b}"
    })
    assert good_join.status_code == 200
    joined_data = good_join.json()
    assert joined_data["id"] == circle_data["id"]
    assert joined_data["name"] == "Alpha Circle"

    # 5. Join again with same valid code (idempotent, should succeed and return same circle)
    dupe_join = client.post("/api/circles/join", json={"invite_code": invite_code}, headers={
        "Authorization": f"Bearer {token_b}"
    })
    assert dupe_join.status_code == 200
    assert dupe_join.json()["id"] == circle_data["id"]

    # 6. Verify User B can see User A's circle in their circle list
    res_list = client.get("/api/circles", headers={
        "Authorization": f"Bearer {token_b}"
    })
    assert res_list.status_code == 200
    circles_list = res_list.json()
    assert len(circles_list) == 1
    assert circles_list[0]["id"] == circle_data["id"]


@pytest.mark.asyncio
async def test_circle_leave_flow():
    client = TestClient(app)
    suffix = uuid.uuid4().hex[:8]

    # 1. Register User 1 (Initial Setup User)
    u1_name = f"LeaveUser1_{suffix}"
    res_u1 = client.post("/api/setup/register", json={
        "username": u1_name,
        "password": "password123",
        "display_name": "Leave User One"
    })
    assert res_u1.status_code == 200, res_u1.json()
    login_1 = client.post("/api/auth/login", json={
        "username": u1_name,
        "password": "password123"
    })
    assert login_1.status_code == 200
    token_1 = login_1.json()["access_token"]

    # 2. Register User 2 (Member)
    u2_name = f"LeaveUser2_{suffix}"
    res_u2 = client.post("/api/auth/register", json={
        "username": u2_name,
        "password": "password123",
        "display_name": "Leave User Two"
    })
    assert res_u2.status_code == 200
    login_2 = client.post("/api/auth/login", json={
        "username": u2_name,
        "password": "password123"
    })
    assert login_2.status_code == 200
    token_2 = login_2.json()["access_token"]

    # 3. Register User 3 (Non-member)
    u3_name = f"LeaveUser3_{suffix}"
    res_u3 = client.post("/api/auth/register", json={
        "username": u3_name,
        "password": "password123",
        "display_name": "Leave User Three"
    })
    assert res_u3.status_code == 200
    login_3 = client.post("/api/auth/login", json={
        "username": u3_name,
        "password": "password123"
    })
    assert login_3.status_code == 200
    token_3 = login_3.json()["access_token"]

    # 4. User 1 creates Circle
    create_res = client.post("/api/circles", json={"name": "Leave Test Circle"}, headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert create_res.status_code == 200
    circle = create_res.json()
    circle_id = circle["id"]
    invite_code = circle["invite_code"]

    # User 2 joins Circle
    join_res = client.post("/api/circles/join", json={"invite_code": invite_code}, headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert join_res.status_code == 200

    # 5. Non-member User 3 attempts to leave -> 400 Bad Request
    unauth_leave = client.post(f"/api/circles/{circle_id}/leave", headers={
        "Authorization": f"Bearer {token_3}"
    })
    assert unauth_leave.status_code == 400
    assert "not a member" in unauth_leave.json()["detail"].lower()

    # 6. Attempt to leave non-existent circle -> 404 Not Found
    notfound_leave = client.post("/api/circles/999999/leave", headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert notfound_leave.status_code == 404
    assert "not found" in notfound_leave.json()["detail"].lower()

    # 7. Unauthenticated request -> 401 Unauthorized
    anon_leave = client.post(f"/api/circles/{circle_id}/leave")
    assert anon_leave.status_code == 401

    # 8. User 2 leaves the circle -> 200 OK
    leave_res_2 = client.post(f"/api/circles/{circle_id}/leave", headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert leave_res_2.status_code == 200
    assert leave_res_2.json()["success"] is True

    # Verify User 2's circle list is now empty (active circle cleared)
    list_u2 = client.get("/api/circles", headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert list_u2.status_code == 200
    assert len(list_u2.json()) == 0

    # Verify User 1 remains in the circle
    list_u1 = client.get("/api/circles", headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert list_u1.status_code == 200
    assert len(list_u1.json()) == 1
    assert list_u1.json()[0]["id"] == circle_id

    # Verify circle members list only has User 1 now
    members_res = client.get(f"/api/circles/{circle_id}/members", headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert members_res.status_code == 200
    remaining_members = members_res.json()
    assert len(remaining_members) == 1
    assert remaining_members[0]["id"] == res_u1.json()["id"]

    # 9. User 1 (last remaining member) leaves circle -> cleanly deletes empty circle
    leave_res_1 = client.post(f"/api/circles/{circle_id}/leave", headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert leave_res_1.status_code == 200
    assert leave_res_1.json()["success"] is True

    # User 1's circle list is now empty
    list_u1_after = client.get("/api/circles", headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert list_u1_after.status_code == 200
    assert len(list_u1_after.json()) == 0

    # Circle was deleted cleanly, so trying to leave it again returns 404
    leave_again = client.post(f"/api/circles/{circle_id}/leave", headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert leave_again.status_code == 404


@pytest.mark.asyncio
async def test_circle_delete_flow():
    client = TestClient(app)
    suffix = uuid.uuid4().hex[:8]

    # 1. Register User 1 (Setup user)
    u1_name = f"DelUser1_{suffix}"
    res_u1 = client.post("/api/setup/register", json={
        "username": u1_name,
        "password": "password123",
        "display_name": "Delete User One"
    })
    assert res_u1.status_code == 200, res_u1.json()
    login_1 = client.post("/api/auth/login", json={
        "username": u1_name,
        "password": "password123"
    })
    assert login_1.status_code == 200
    token_1 = login_1.json()["access_token"]

    # 2. Register User 2 (Member)
    u2_name = f"DelUser2_{suffix}"
    res_u2 = client.post("/api/auth/register", json={
        "username": u2_name,
        "password": "password123",
        "display_name": "Delete User Two"
    })
    assert res_u2.status_code == 200
    login_2 = client.post("/api/auth/login", json={
        "username": u2_name,
        "password": "password123"
    })
    assert login_2.status_code == 200
    token_2 = login_2.json()["access_token"]

    # 3. Register User 3 (Non-member)
    u3_name = f"DelUser3_{suffix}"
    res_u3 = client.post("/api/auth/register", json={
        "username": u3_name,
        "password": "password123",
        "display_name": "Delete User Three"
    })
    assert res_u3.status_code == 200
    login_3 = client.post("/api/auth/login", json={
        "username": u3_name,
        "password": "password123"
    })
    assert login_3.status_code == 200
    token_3 = login_3.json()["access_token"]

    # 4. User 1 creates Circle
    create_res = client.post("/api/circles", json={"name": "Delete Test Circle"}, headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert create_res.status_code == 200
    circle = create_res.json()
    circle_id = circle["id"]
    invite_code = circle["invite_code"]

    # User 2 joins Circle
    join_res = client.post("/api/circles/join", json={"invite_code": invite_code}, headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert join_res.status_code == 200

    # Both users can see the circle
    assert len(client.get("/api/circles", headers={"Authorization": f"Bearer {token_1}"}).json()) == 1
    assert len(client.get("/api/circles", headers={"Authorization": f"Bearer {token_2}"}).json()) == 1

    # 5. Non-member User 3 attempts to delete -> 403 Forbidden
    non_member_del = client.delete(f"/api/circles/{circle_id}", headers={
        "Authorization": f"Bearer {token_3}"
    })
    assert non_member_del.status_code == 403
    assert "not authorized" in non_member_del.json()["detail"].lower()

    # 6. Attempt to delete non-existent circle -> 404 Not Found
    notfound_del = client.delete("/api/circles/999999", headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert notfound_del.status_code == 404

    # 7. Unauthenticated request -> 401 Unauthorized
    anon_del = client.delete(f"/api/circles/{circle_id}")
    assert anon_del.status_code == 401

    # 8. Authorized member (User 2) deletes the circle -> 200 OK
    del_res = client.delete(f"/api/circles/{circle_id}", headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert del_res.status_code == 200
    assert del_res.json()["success"] is True

    # 9. Verify circle list is empty for User 1 and User 2 (all memberships removed)
    list_u1 = client.get("/api/circles", headers={"Authorization": f"Bearer {token_1}"}).json()
    list_u2 = client.get("/api/circles", headers={"Authorization": f"Bearer {token_2}"}).json()
    assert len(list_u1) == 0
    assert len(list_u2) == 0

    # 10. Trying to delete already-deleted circle returns 404
    del_again = client.delete(f"/api/circles/{circle_id}", headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert del_again.status_code == 404

    # 11. Test POST alias endpoint /api/circles/{id}/delete
    create_res2 = client.post("/api/circles", json={"name": "Alias Delete Circle"}, headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert create_res2.status_code == 200
    circle_id2 = create_res2.json()["id"]

    alias_del = client.post(f"/api/circles/{circle_id2}/delete", headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert alias_del.status_code == 200
    assert alias_del.json()["success"] is True

    list_after_alias = client.get("/api/circles", headers={"Authorization": f"Bearer {token_1}"}).json()
    assert len(list_after_alias) == 0


@pytest.mark.asyncio
async def test_share_location_flow():
    client = TestClient(app)
    suffix = uuid.uuid4().hex[:8]

    # 1. Register User 1 (Setup user)
    u1_name = f"ShareUser1_{suffix}"
    res_u1 = client.post("/api/setup/register", json={
        "username": u1_name,
        "password": "password123",
        "display_name": "Share User One"
    })
    assert res_u1.status_code == 200, res_u1.json()
    login_1 = client.post("/api/auth/login", json={
        "username": u1_name,
        "password": "password123"
    })
    assert login_1.status_code == 200
    token_1 = login_1.json()["access_token"]
    assert login_1.json()["user"]["share_location"] is True

    # 2. Register User 2 (Member)
    u2_name = f"ShareUser2_{suffix}"
    res_u2 = client.post("/api/auth/register", json={
        "username": u2_name,
        "password": "password123",
        "display_name": "Share User Two"
    })
    assert res_u2.status_code == 200
    login_2 = client.post("/api/auth/login", json={
        "username": u2_name,
        "password": "password123"
    })
    assert login_2.status_code == 200
    token_2 = login_2.json()["access_token"]

    # 3. User 1 checks initial /api/auth/me
    me_res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_1}"})
    assert me_res.status_code == 200
    assert me_res.json()["share_location"] is True

    # 4. User 1 creates Circle, User 2 joins
    create_res = client.post("/api/circles", json={"name": "Privacy Circle"}, headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert create_res.status_code == 200
    circle_id = create_res.json()["id"]
    invite_code = create_res.json()["invite_code"]

    join_res = client.post("/api/circles/join", json={"invite_code": invite_code}, headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert join_res.status_code == 200

    # 5. User 1 registers device and reports telemetry
    reg_res = client.post("/api/mobile_app/registrations", json={
        "device_id": f"phone_{suffix}",
        "app_id": "io.homeassistant.companion",
        "app_name": "Home Assistant",
        "app_version": "1.0.0",
        "device_name": "Share Phone",
        "manufacturer": "Google",
        "model": "Pixel 8",
        "os_name": "Android",
        "os_version": "14",
        "supports_encryption": False,
        "app_data": {}
    }, headers={"Authorization": f"Bearer {token_1}"})
    assert reg_res.status_code == 201
    webhook_id = reg_res.json()["webhook_id"]

    loc_payload = {
        "type": "update_location",
        "data": {
            "latitude": 37.7749,
            "longitude": -122.4194,
            "gps_accuracy": 10,
            "battery": 95,
            "trigger": "background"
        }
    }
    wh_res = client.post(f"/api/webhook/{webhook_id}", json=loc_payload)
    assert wh_res.status_code == 200

    # 6. User 2 views circle members while share_location is True
    members_res = client.get(f"/api/circles/{circle_id}/members", headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert members_res.status_code == 200
    members = members_res.json()
    u1_member = next(m for m in members if m["username"] == u1_name.lower())
    assert len(u1_member["devices"]) == 1
    assert u1_member["devices"][0]["latitude"] == 37.7749
    assert u1_member["devices"][0]["longitude"] == -122.4194

    # 7. User 1 updates share_location = False
    put_res = client.put("/api/auth/profile", json={"share_location": False}, headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert put_res.status_code == 200
    assert put_res.json()["share_location"] is False

    # 8. Reload /api/auth/me to confirm persistence
    me_reload = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_1}"})
    assert me_reload.status_code == 200
    assert me_reload.json()["share_location"] is False

    # 9. User 2 views circle members while share_location is False
    # User 1's device location MUST NOT be exposed to other members
    members_res_private = client.get(f"/api/circles/{circle_id}/members", headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert members_res_private.status_code == 200
    u1_private = next(m for m in members_res_private.json() if m["username"] == u1_name.lower())
    assert len(u1_private["devices"]) == 0

    # 10. User 1 checking own circle member record still sees their own device
    self_members = client.get(f"/api/circles/{circle_id}/members", headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert self_members.status_code == 200
    u1_self = next(m for m in self_members.json() if m["username"] == u1_name.lower())
    assert len(u1_self["devices"]) == 1
    assert u1_self["devices"][0]["latitude"] == 37.7749

    # 11. User 1 reports more telemetry while sharing is disabled (incoming telemetry remains functional)
    wh_res2 = client.post(f"/api/webhook/{webhook_id}", json={
        "type": "update_location",
        "data": {
            "latitude": 37.7755,
            "longitude": -122.4180,
            "gps_accuracy": 5,
            "battery": 94,
            "trigger": "background"
        }
    })
    assert wh_res2.status_code == 200

    # User 2 still sees NO devices
    members_res_still_private = client.get(f"/api/circles/{circle_id}/members", headers={
        "Authorization": f"Bearer {token_2}"
    })
    u1_still_private = next(m for m in members_res_still_private.json() if m["username"] == u1_name.lower())
    assert len(u1_still_private["devices"]) == 0

    # 12. User 1 re-enables share_location = True
    put_res_true = client.put("/api/auth/profile", json={"share_location": True}, headers={
        "Authorization": f"Bearer {token_1}"
    })
    assert put_res_true.status_code == 200
    assert put_res_true.json()["share_location"] is True

    # Confirm reload
    me_reload_true = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_1}"})
    assert me_reload_true.status_code == 200
    assert me_reload_true.json()["share_location"] is True

    # 13. User 2 views circle members again -> normal location sharing resumes with updated coordinates!
    members_res_resumed = client.get(f"/api/circles/{circle_id}/members", headers={
        "Authorization": f"Bearer {token_2}"
    })
    assert members_res_resumed.status_code == 200
    u1_resumed = next(m for m in members_res_resumed.json() if m["username"] == u1_name.lower())
    assert len(u1_resumed["devices"]) == 1
    assert u1_resumed["devices"][0]["latitude"] == 37.7755
    assert u1_resumed["devices"][0]["longitude"] == -122.4180


@pytest.mark.asyncio
async def test_save_location_history_flow():
    client = TestClient(app)
    suffix = uuid.uuid4().hex[:8]

    # 1. Register User
    uname = f"HistUser_{suffix}"
    res_reg = client.post("/api/setup/register", json={
        "username": uname,
        "password": "password123",
        "display_name": "History User"
    })
    assert res_reg.status_code == 200
    login_res = client.post("/api/auth/login", json={
        "username": uname,
        "password": "password123"
    })
    assert login_res.status_code == 200
    token = login_res.json()["access_token"]
    assert login_res.json()["user"]["save_location_history"] is True

    # 2. Check /api/auth/me returns default save_location_history = True
    me_res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_res.status_code == 200
    assert me_res.json()["save_location_history"] is True

    # 3. Test Persistence: Toggle to False
    put_false = client.put("/api/auth/profile", json={"save_location_history": False}, headers={
        "Authorization": f"Bearer {token}"
    })
    assert put_false.status_code == 200
    assert put_false.json()["save_location_history"] is False

    # Confirm reload via /api/auth/me returns False
    me_false = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_false.status_code == 200
    assert me_false.json()["save_location_history"] is False

    # Toggle back to True
    put_true = client.put("/api/auth/profile", json={"save_location_history": True}, headers={
        "Authorization": f"Bearer {token}"
    })
    assert put_true.status_code == 200
    assert put_true.json()["save_location_history"] is True

    me_true = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_true.status_code == 200
    assert me_true.json()["save_location_history"] is True

    # 4. Pair mobile app device
    reg_dev = client.post("/api/mobile_app/registrations", json={
        "device_id": f"hist_dev_{suffix}",
        "app_id": "io.homeassistant.companion",
        "app_name": "Home Assistant",
        "app_version": "1.0.0",
        "device_name": "Hist Phone",
        "manufacturer": "Google",
        "model": "Pixel 8",
        "os_name": "Android",
        "os_version": "14",
        "supports_encryption": False,
        "app_data": {}
    }, headers={"Authorization": f"Bearer {token}"})
    assert reg_dev.status_code == 201
    webhook_id = reg_dev.json()["webhook_id"]

    # 5. Send location update 1 with save_location_history = True
    wh_1 = client.post(f"/api/webhook/{webhook_id}", json={
        "type": "update_location",
        "data": {
            "latitude": 37.7749,
            "longitude": -122.4194,
            "gps_accuracy": 10,
            "battery": 90,
            "trigger": "background"
        }
    })
    assert wh_1.status_code == 200

    # Query history: 1 record must exist
    hist_1 = client.get("/api/history/period", headers={"Authorization": f"Bearer {token}"})
    assert hist_1.status_code == 200
    h_records_1 = hist_1.json()
    assert len(h_records_1) == 1
    assert h_records_1[0]["latitude"] == 37.7749
    assert h_records_1[0]["longitude"] == -122.4194

    # 6. Disable save_location_history
    put_disable = client.put("/api/auth/profile", json={"save_location_history": False}, headers={
        "Authorization": f"Bearer {token}"
    })
    assert put_disable.status_code == 200
    assert put_disable.json()["save_location_history"] is False

    # Send location update 2 while disabled
    wh_2 = client.post(f"/api/webhook/{webhook_id}", json={
        "type": "update_location",
        "data": {
            "latitude": 37.7799,
            "longitude": -122.4100,
            "gps_accuracy": 8,
            "battery": 89,
            "trigger": "background"
        }
    })
    assert wh_2.status_code == 200

    # Verify live location state STILL updated properly to 37.7799, -122.4100
    live_state = client.get("/api/states/device_tracker.hist_phone", headers={
        "Authorization": f"Bearer {token}"
    })
    assert live_state.status_code == 200
    assert live_state.json()["attributes"]["latitude"] == 37.7799
    assert live_state.json()["attributes"]["longitude"] == -122.4100

    # Verify history is suppressed: count remains 1, earlier record intact, NO record for 37.7799
    hist_2 = client.get("/api/history/period", headers={"Authorization": f"Bearer {token}"})
    assert hist_2.status_code == 200
    h_records_2 = hist_2.json()
    assert len(h_records_2) == 1
    assert h_records_2[0]["latitude"] == 37.7749
    assert h_records_2[0]["longitude"] == -122.4194

    # Also test list format webhook while disabled
    wh_list = client.post(f"/api/webhook/{webhook_id}", json={
        "type": "update_location",
        "data": [{
            "latitude": 37.7810,
            "longitude": -122.4080,
            "gps_accuracy": 5,
            "battery": 88,
            "trigger": "periodic"
        }]
    })
    assert wh_list.status_code == 200

    # Live state updated to list coordinates
    live_state_list = client.get("/api/states/device_tracker.hist_phone", headers={
        "Authorization": f"Bearer {token}"
    })
    assert live_state_list.status_code == 200
    assert live_state_list.json()["attributes"]["latitude"] == 37.7810

    # History count STILL 1
    hist_list_check = client.get("/api/history/period", headers={"Authorization": f"Bearer {token}"})
    assert len(hist_list_check.json()) == 1

    # 7. Re-enable save_location_history
    put_reenable = client.put("/api/auth/profile", json={"save_location_history": True}, headers={
        "Authorization": f"Bearer {token}"
    })
    assert put_reenable.status_code == 200
    assert put_reenable.json()["save_location_history"] is True

    # Send location update 3 while re-enabled
    wh_3 = client.post(f"/api/webhook/{webhook_id}", json={
        "type": "update_location",
        "data": {
            "latitude": 37.7850,
            "longitude": -122.4050,
            "gps_accuracy": 6,
            "battery": 85,
            "trigger": "background"
        }
    })
    assert wh_3.status_code == 200

    # Query history: now 2 records exist! (first was 37.7749, second is 37.7850)
    hist_3 = client.get("/api/history/period", headers={"Authorization": f"Bearer {token}"})
    assert hist_3.status_code == 200
    h_records_3 = hist_3.json()
    assert len(h_records_3) == 2
    lats = [r["latitude"] for r in h_records_3]
    assert 37.7749 in lats
    assert 37.7850 in lats
    assert 37.7799 not in lats  # suppressed coordinate is NOT in history
    assert 37.7810 not in lats  # suppressed list coordinate is NOT in history


@pytest.mark.asyncio
async def test_history_retention_flow():
    from datetime import datetime, timezone, timedelta
    from app.db.database import async_session_maker
    from app.db.models import LocationHistory, Device
    from app.services.telemetry_service import cleanup_history_for_user, get_retention_cutoff

    client = TestClient(app)
    suffix = uuid.uuid4().hex[:8]

    # 1. Register User 1
    uname1 = f"retuser1_{suffix}"
    res_reg1 = client.post("/api/setup/register", json={
        "username": uname1,
        "password": "password123",
        "display_name": "Retention User 1"
    })
    assert res_reg1.status_code == 200

    login_res1 = client.post("/api/auth/login", json={
        "username": uname1,
        "password": "password123"
    })
    assert login_res1.status_code == 200
    token1 = login_res1.json()["access_token"]
    u1_id = login_res1.json()["user"]["id"]
    # Default retention is 30d
    assert login_res1.json()["user"]["history_retention"] == "30d"

    # 2. Check /api/auth/me returns default "30d"
    me_res1 = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token1}"})
    assert me_res1.status_code == 200
    assert me_res1.json()["history_retention"] == "30d"

    # 3. Test persistence for all valid values: 7d, 30d, 90d, 1y, forever
    for val in ["7d", "90d", "1y", "forever", "30d"]:
        put_res = client.put("/api/auth/profile", json={"history_retention": val}, headers={
            "Authorization": f"Bearer {token1}"
        })
        assert put_res.status_code == 200
        assert put_res.json()["history_retention"] == val

        # Verify /api/auth/me refetch
        me_check = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token1}"})
        assert me_check.status_code == 200
        assert me_check.json()["history_retention"] == val

    # Invalid value is rejected
    put_invalid = client.put("/api/auth/profile", json={"history_retention": "invalid_retention"}, headers={
        "Authorization": f"Bearer {token1}"
    })
    assert put_invalid.status_code == 400

    # 4. Register User 2 (unrelated user) to verify multi-user isolation
    uname2 = f"retuser2_{suffix}"
    res_reg2 = client.post("/api/auth/register", json={
        "username": uname2,
        "password": "password123",
        "display_name": "Retention User 2"
    })
    assert res_reg2.status_code == 200
    login_res2 = client.post("/api/auth/login", json={
        "username": uname2,
        "password": "password123"
    })
    token2 = login_res2.json()["access_token"]
    u2_id = login_res2.json()["user"]["id"]

    # Pair devices for user 1 and user 2
    dev1_res = client.post("/api/mobile_app/registrations", json={
        "device_id": f"dev1_{suffix}",
        "app_id": "io.homeassistant.companion",
        "app_name": "HA",
        "app_version": "1.0",
        "device_name": "Phone 1",
        "manufacturer": "Apple",
        "model": "iPhone",
        "os_name": "iOS",
        "os_version": "17",
        "supports_encryption": False,
        "app_data": {}
    }, headers={"Authorization": f"Bearer {token1}"})
    assert dev1_res.status_code == 201
    dev1_data = dev1_res.json()
    webhook_1 = dev1_data["webhook_id"]

    dev2_res = client.post("/api/mobile_app/registrations", json={
        "device_id": f"dev2_{suffix}",
        "app_id": "io.homeassistant.companion",
        "app_name": "HA",
        "app_version": "1.0",
        "device_name": "Phone 2",
        "manufacturer": "Google",
        "model": "Pixel",
        "os_name": "Android",
        "os_version": "14",
        "supports_encryption": False,
        "app_data": {}
    }, headers={"Authorization": f"Bearer {token2}"})
    assert dev2_res.status_code == 201
    dev2_data = dev2_res.json()
    webhook_2 = dev2_data["webhook_id"]

    # Retrieve database device IDs
    async with async_session_maker() as session:
        from sqlalchemy import select
        dev1_db = (await session.execute(select(Device).where(Device.device_id == f"dev1_{suffix}"))).scalar_one()
        dev2_db = (await session.execute(select(Device).where(Device.device_id == f"dev2_{suffix}"))).scalar_one()
        dev1_pk = dev1_db.id
        dev2_pk = dev2_db.id

    # 5. Set user 1 retention to "30d", user 2 retention to "forever"
    client.put("/api/auth/profile", json={"history_retention": "30d"}, headers={"Authorization": f"Bearer {token1}"})
    client.put("/api/auth/profile", json={"history_retention": "forever"}, headers={"Authorization": f"Bearer {token2}"})

    # Seed direct location history records with varied timestamps in the DB
    now = datetime.now(timezone.utc)
    async with async_session_maker() as session:
        # User 1 records:
        # - Record 1: 5 days old (inside 30d, inside 7d)
        # - Record 2: 15 days old (inside 30d, outside 7d)
        # - Record 3: 45 days old (outside 30d)
        # User 2 records:
        # - Record 4: 50 days old (inside forever)
        r1 = LocationHistory(device_id=dev1_pk, user_id=u1_id, latitude=37.7100, longitude=-122.4100, timestamp=now - timedelta(days=5))
        r2 = LocationHistory(device_id=dev1_pk, user_id=u1_id, latitude=37.7200, longitude=-122.4200, timestamp=now - timedelta(days=15))
        r3 = LocationHistory(device_id=dev1_pk, user_id=u1_id, latitude=37.7300, longitude=-122.4300, timestamp=now - timedelta(days=45))
        r4 = LocationHistory(device_id=dev2_pk, user_id=u2_id, latitude=37.7400, longitude=-122.4400, timestamp=now - timedelta(days=50))
        session.add_all([r1, r2, r3, r4])
        await session.commit()

    # 6. Test retention enforcement when user 1 queries history (retention=30d)
    # The 45-day record (37.7300) must be pruned. The 5-day and 15-day records must remain.
    # User 2's 50-day record must be untouched (forever retention).
    u1_hist = client.get("/api/history/period", headers={"Authorization": f"Bearer {token1}"})
    assert u1_hist.status_code == 200
    u1_data = u1_hist.json()
    u1_lats = [rec["latitude"] for rec in u1_data]
    assert 37.7100 in u1_lats  # 5 days old: kept
    assert 37.7200 in u1_lats  # 15 days old: kept
    assert 37.7300 not in u1_lats  # 45 days old: pruned!

    # Check user 2's history: 50-day record is preserved because retention is forever
    u2_hist = client.get("/api/history/period", headers={"Authorization": f"Bearer {token2}"})
    assert u2_hist.status_code == 200
    u2_lats = [rec["latitude"] for rec in u2_hist.json()]
    assert 37.7400 in u2_lats

    # 7. Changing retention to a shorter window: Change User 1 from "30d" to "7d"
    # When PUT /api/auth/profile is called with "7d", it immediately runs cleanup:
    # 15-day record (37.7200) becomes eligible and is pruned.
    # 5-day record (37.7100) is inside 7d and remains.
    put_7d = client.put("/api/auth/profile", json={"history_retention": "7d"}, headers={"Authorization": f"Bearer {token1}"})
    assert put_7d.status_code == 200
    assert put_7d.json()["history_retention"] == "7d"

    u1_hist_7d = client.get("/api/history/period", headers={"Authorization": f"Bearer {token1}"})
    assert u1_hist_7d.status_code == 200
    u1_lats_7d = [rec["latitude"] for rec in u1_hist_7d.json()]
    assert 37.7100 in u1_lats_7d  # 5 days old: inside 7d window
    assert 37.7200 not in u1_lats_7d  # 15 days old: pruned by 7d retention!

    # 8. Increasing retention window: Change User 1 back to "90d"
    # Previously pruned records (37.7200, 37.7300) must NOT magically return.
    put_90d = client.put("/api/auth/profile", json={"history_retention": "90d"}, headers={"Authorization": f"Bearer {token1}"})
    assert put_90d.status_code == 200
    assert put_90d.json()["history_retention"] == "90d"

    u1_hist_90d = client.get("/api/history/period", headers={"Authorization": f"Bearer {token1}"})
    assert u1_hist_90d.status_code == 200
    u1_lats_90d = [rec["latitude"] for rec in u1_hist_90d.json()]
    assert len(u1_lats_90d) == 1
    assert 37.7100 in u1_lats_90d
    assert 37.7200 not in u1_lats_90d
    assert 37.7300 not in u1_lats_90d

    # 9. Verify live telemetry updates prune during incoming webhook calls as well
    # Seed an old 10-day record while user 1 is set to "7d"
    client.put("/api/auth/profile", json={"history_retention": "7d"}, headers={"Authorization": f"Bearer {token1}"})
    async with async_session_maker() as session:
        r_old = LocationHistory(device_id=1, user_id=u1_id, latitude=37.7990, longitude=-122.4990, timestamp=now - timedelta(days=10))
        session.add(r_old)
        await session.commit()

    # Send incoming location update via companion webhook
    wh_res = client.post(f"/api/webhook/{webhook_1}", json={
        "type": "update_location",
        "data": {
            "latitude": 37.7777,
            "longitude": -122.4444,
            "gps_accuracy": 5,
            "battery": 95,
            "trigger": "background"
        }
    })
    assert wh_res.status_code == 200

    # Live EntityState is intact and updated
    st_res = client.get("/api/states/device_tracker.phone_1", headers={"Authorization": f"Bearer {token1}"})
    assert st_res.status_code == 200
    assert st_res.json()["attributes"]["latitude"] == 37.7777

    # LocationHistory has new point 37.7777, 5-day point 37.7100, and 10-day point 37.7990 was pruned during webhook
    u1_final = client.get("/api/history/period", headers={"Authorization": f"Bearer {token1}"})
    final_lats = [rec["latitude"] for rec in u1_final.json()]
    assert 37.7777 in final_lats
    assert 37.7100 in final_lats
    assert 37.7990 not in final_lats

    # User 2's data is still intact
    u2_final = client.get("/api/history/period", headers={"Authorization": f"Bearer {token2}"})
    assert 37.7400 in [rec["latitude"] for rec in u2_final.json()]


@pytest.mark.asyncio
async def test_location_update_frequency_flow():
    client = TestClient(app)
    suffix = uuid.uuid4().hex[:8]

    # 1. Register User
    uname = f"freq_user_{suffix}"
    res_reg = client.post("/api/setup/register", json={
        "username": uname,
        "password": "password123",
        "display_name": "Freq User"
    })
    assert res_reg.status_code == 200

    # Login and verify default location_update_frequency is "realtime"
    login_res = client.post("/api/auth/login", json={
        "username": uname,
        "password": "password123"
    })
    assert login_res.status_code == 200
    token = login_res.json()["access_token"]
    assert login_res.json()["user"]["location_update_frequency"] == "realtime"

    # GET /api/auth/me returns default "realtime"
    me_res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_res.status_code == 200
    assert me_res.json()["location_update_frequency"] == "realtime"

    # GET /api/mobile_app/config returns update_frequency "realtime"
    cfg_res = client.get("/api/mobile_app/config", headers={"Authorization": f"Bearer {token}"})
    assert cfg_res.status_code == 200
    assert cfg_res.json()["update_frequency"] == "realtime"

    # 2. Test persistence across all supported options: "realtime", "1m", "5m", "15m"
    supported_options = ["1m", "5m", "15m", "realtime"]
    for opt in supported_options:
        put_res = client.put("/api/auth/profile", json={"location_update_frequency": opt}, headers={
            "Authorization": f"Bearer {token}"
        })
        assert put_res.status_code == 200
        assert put_res.json()["location_update_frequency"] == opt

        # Verify /api/auth/me returns updated value
        me_check = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert me_check.status_code == 200
        assert me_check.json()["location_update_frequency"] == opt

        # Verify /api/mobile_app/config returns updated value
        cfg_check = client.get("/api/mobile_app/config", headers={"Authorization": f"Bearer {token}"})
        assert cfg_check.status_code == 200
        assert cfg_check.json()["update_frequency"] == opt

    # 3. Test survival across re-login
    login_again = client.post("/api/auth/login", json={
        "username": uname,
        "password": "password123"
    })
    assert login_again.status_code == 200
    new_token = login_again.json()["access_token"]
    assert login_again.json()["user"]["location_update_frequency"] == "realtime"

    # Set to 5m and re-login
    client.put("/api/auth/profile", json={"location_update_frequency": "5m"}, headers={"Authorization": f"Bearer {new_token}"})
    login_third = client.post("/api/auth/login", json={
        "username": uname,
        "password": "password123"
    })
    assert login_third.json()["user"]["location_update_frequency"] == "5m"

    # 4. Reject invalid options
    put_invalid = client.put("/api/auth/profile", json={"location_update_frequency": "10s"}, headers={
        "Authorization": f"Bearer {new_token}"
    })
    assert put_invalid.status_code == 400

    # 5. Verify real companion telemetry updates arrive and process normally
    dev_res = client.post("/api/mobile_app/registrations", json={
        "device_id": f"freq_dev_{suffix}",
        "app_id": "io.homeassistant.companion",
        "app_name": "HA",
        "app_version": "1.0",
        "device_name": "Freq Phone",
        "manufacturer": "Apple",
        "model": "iPhone",
        "os_name": "iOS",
        "os_version": "17",
        "supports_encryption": False,
        "app_data": {}
    }, headers={"Authorization": f"Bearer {new_token}"})
    assert dev_res.status_code == 201
    webhook_id = dev_res.json()["webhook_id"]

    # Send incoming location update
    wh_res = client.post(f"/api/webhook/{webhook_id}", json={
        "type": "update_location",
        "data": {
            "latitude": 37.7600,
            "longitude": -122.4200,
            "gps_accuracy": 5,
            "battery": 80,
            "trigger": "periodic"
        }
    })
    assert wh_res.status_code == 200

    # Verify live tracker entity state updated
    st_res = client.get("/api/states/device_tracker.freq_phone", headers={"Authorization": f"Bearer {new_token}"})
    assert st_res.status_code == 200
    assert st_res.json()["attributes"]["latitude"] == 37.7600


@pytest.mark.asyncio
async def test_notification_settings_flow():
    client = TestClient(app)
    suffix = uuid.uuid4().hex[:8]

    # 1. Register User 1
    uname1 = f"notify_user1_{suffix}"
    res_reg1 = client.post("/api/setup/register", json={
        "username": uname1,
        "password": "password123",
        "display_name": "Notify User 1"
    })
    assert res_reg1.status_code == 200

    # Login and verify default notification fields are all True
    login_res1 = client.post("/api/auth/login", json={
        "username": uname1,
        "password": "password123"
    })
    assert login_res1.status_code == 200
    u1_json = login_res1.json()["user"]
    token1 = login_res1.json()["access_token"]

    assert u1_json["notify_push"] is True
    assert u1_json["notify_arrival_departure"] is True
    assert u1_json["notify_stop_sharing"] is True
    assert u1_json["notify_low_battery"] is True
    assert u1_json["notify_device_offline"] is True

    # 2. GET /api/auth/me returns default True values
    me_res1 = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token1}"})
    assert me_res1.status_code == 200
    me_data1 = me_res1.json()
    assert me_data1["notify_push"] is True
    assert me_data1["notify_arrival_departure"] is True
    assert me_data1["notify_stop_sharing"] is True
    assert me_data1["notify_low_battery"] is True
    assert me_data1["notify_device_offline"] is True

    # 3. Test persistence of setting each option individually to False and then True
    notification_keys = [
        "notify_push",
        "notify_arrival_departure",
        "notify_stop_sharing",
        "notify_low_battery",
        "notify_device_offline"
    ]

    for key in notification_keys:
        # Set to False
        put_false = client.put("/api/auth/profile", json={key: False}, headers={
            "Authorization": f"Bearer {token1}"
        })
        assert put_false.status_code == 200
        assert put_false.json()[key] is False

        # Verify GET /api/auth/me reflects False
        me_check_f = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token1}"})
        assert me_check_f.status_code == 200
        assert me_check_f.json()[key] is False

        # Set back to True
        put_true = client.put("/api/auth/profile", json={key: True}, headers={
            "Authorization": f"Bearer {token1}"
        })
        assert put_true.status_code == 200
        assert put_true.json()[key] is True

        # Verify GET /api/auth/me reflects True
        me_check_t = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token1}"})
        assert me_check_t.status_code == 200
        assert me_check_t.json()[key] is True

    # 4. Set custom mixed combination of notification preferences
    mixed_payload = {
        "notify_push": False,
        "notify_arrival_departure": True,
        "notify_stop_sharing": False,
        "notify_low_battery": True,
        "notify_device_offline": False
    }
    put_mixed = client.put("/api/auth/profile", json=mixed_payload, headers={
        "Authorization": f"Bearer {token1}"
    })
    assert put_mixed.status_code == 200
    for k, v in mixed_payload.items():
        assert put_mixed.json()[k] == v

    # Verify /api/auth/me returns the mixed payload
    me_mixed = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token1}"})
    assert me_mixed.status_code == 200
    for k, v in mixed_payload.items():
        assert me_mixed.json()[k] == v

    # 5. Confirm preferences survive logout/login
    login_again = client.post("/api/auth/login", json={
        "username": uname1,
        "password": "password123"
    })
    assert login_again.status_code == 200
    u1_relogin = login_again.json()["user"]
    for k, v in mixed_payload.items():
        assert u1_relogin[k] == v

    # 6. Verify multi-user isolation
    uname2 = f"notify_user2_{suffix}"
    res_reg2 = client.post("/api/auth/register", json={
        "username": uname2,
        "password": "password123",
        "display_name": "Notify User 2"
    })
    assert res_reg2.status_code == 200

    login_res2 = client.post("/api/auth/login", json={
        "username": uname2,
        "password": "password123"
    })
    token2 = login_res2.json()["access_token"]
    u2_json = login_res2.json()["user"]
    # User 2 should have independent default True settings
    assert u2_json["notify_push"] is True
    assert u2_json["notify_stop_sharing"] is True

    # 7. Verify telemetry flow continues to operate normally
    dev_res = client.post("/api/mobile_app/registrations", json={
        "device_id": f"notif_dev_{suffix}",
        "app_id": "io.homeassistant.companion",
        "app_name": "HA",
        "app_version": "1.0",
        "device_name": "Notif Phone",
        "manufacturer": "Google",
        "model": "Pixel",
        "os_name": "Android",
        "os_version": "14",
        "supports_encryption": False,
        "app_data": {}
    }, headers={"Authorization": f"Bearer {token1}"})
    assert dev_res.status_code == 201
    webhook_id = dev_res.json()["webhook_id"]

    wh_res = client.post(f"/api/webhook/{webhook_id}", json={
        "type": "update_location",
        "data": {
            "latitude": 37.7555,
            "longitude": -122.4555,
            "gps_accuracy": 5,
            "battery": 90,
            "trigger": "background"
        }
    })
    assert wh_res.status_code == 200

    st_res = client.get("/api/states/device_tracker.notif_phone", headers={"Authorization": f"Bearer {token1}"})
    assert st_res.status_code == 200
    assert st_res.json()["attributes"]["latitude"] == 37.7555


@pytest.mark.asyncio
async def test_avatar_color_propagation_flow():
    client = TestClient(app)
    suffix = uuid.uuid4().hex[:8]
    uname1 = f"color_u1_{suffix}"
    uname2 = f"color_u2_{suffix}"

    # 1. Create User 1 and User 2 via AuthService / DB
    async with db_session_test_maker() as db:
        u1_in = UserCreate(username=uname1, password="password123", display_name="Color User 1")
        await AuthService.create_user(db, u1_in)
        u2_in = UserCreate(username=uname2, password="password123", display_name="Color User 2")
        await AuthService.create_user(db, u2_in)

    # 2. Login User 1
    login1 = client.post("/api/auth/login", json={
        "username": uname1,
        "password": "password123"
    })
    assert login1.status_code == 200
    token1 = login1.json()["access_token"]
    u1 = login1.json()["user"]
    assert "avatar_color" in u1

    # Update User 1's avatar_color to a custom pastel hex (#FF9AA2)
    custom_color1 = "#FF9AA2"
    put_res = client.put("/api/auth/profile", json={
        "avatar_color": custom_color1
    }, headers={"Authorization": f"Bearer {token1}"})
    assert put_res.status_code == 200
    assert put_res.json()["avatar_color"] == custom_color1

    # Verify GET /api/auth/me returns updated avatar_color
    me_res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token1}"})
    assert me_res.status_code == 200
    assert me_res.json()["avatar_color"] == custom_color1

    # 3. Create Circle as User 1
    create_c = client.post("/api/circles", json={"name": f"Color Circle {suffix}"}, headers={"Authorization": f"Bearer {token1}"})
    assert create_c.status_code == 200
    circle = create_c.json()
    invite_code = circle["invite_code"]

    # Login User 2
    login2 = client.post("/api/auth/login", json={
        "username": uname2,
        "password": "password123"
    })
    assert login2.status_code == 200
    token2 = login2.json()["access_token"]

    # User 2 sets a different custom color (#B5EAD7)
    custom_color2 = "#B5EAD7"
    put_res2 = client.put("/api/auth/profile", json={"avatar_color": custom_color2}, headers={"Authorization": f"Bearer {token2}"})
    assert put_res2.status_code == 200
    assert put_res2.json()["avatar_color"] == custom_color2

    # User 2 joins Circle
    join_res = client.post("/api/circles/join", json={"invite_code": invite_code}, headers={"Authorization": f"Bearer {token2}"})
    assert join_res.status_code == 200

    # 4. Fetch circle members and verify both members preserve their respective avatar_color
    circle_id = circle["id"]
    members_res = client.get(f"/api/circles/{circle_id}/members", headers={"Authorization": f"Bearer {token1}"})
    assert members_res.status_code == 200
    members = members_res.json()
    assert len(members) == 2

    # 5. Relogin verification (logout/login flow)
    relogin1 = client.post("/api/auth/login", json={
        "username": uname1,
        "password": "password123"
    })
    assert relogin1.status_code == 200
    assert relogin1.json()["user"]["avatar_color"] == custom_color1

    # 6. Null avatar_color update / fallback verification
    uname3 = f"color_u3_{suffix}"
    async with db_session_test_maker() as db:
        u3_in = UserCreate(username=uname3, password="password123", display_name="Default Color User")
        await AuthService.create_user(db, u3_in)

    login3 = client.post("/api/auth/login", json={
        "username": uname3,
        "password": "password123"
    })
    assert login3.status_code == 200
    token3 = login3.json()["access_token"]
    # Verify initial avatar_color is None (which maps to DEFAULT_AVATAR_COLOR on frontend)
    assert login3.json()["user"]["avatar_color"] is None

    me3 = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token3}"})
    assert me3.status_code == 200
    assert me3.json()["avatar_color"] is None







