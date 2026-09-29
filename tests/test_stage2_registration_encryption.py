import asyncio
import os
import secrets
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import select

from app.main import app
from app.db.database import Base, get_db
from app.db.models import User, Device, EntityState, SensorRegistration, LocationHistory
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService
from app.services.encryption_service import EncryptionService
from app.core.security import create_jwt_token

TEST_DATABASE_URL = "sqlite+aiosqlite:////tmp/test_ha_stage2.db"
test_engine = create_async_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
db_session_test_maker = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)

@pytest.fixture(autouse=True, scope="function")
def setup_test_db():
    import app.db.database
    orig_session_maker = app.db.database.async_session_maker
    app.db.database.async_session_maker = db_session_test_maker

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

    for db_file in ["/tmp/test_ha_stage2.db", "/tmp/test_ha_stage2.db-shm", "/tmp/test_ha_stage2.db-wal"]:
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

def test_encryption_service_unit():
    """Unit tests for standalone EncryptionService (XSalsa20-Poly1305)."""
    secret = EncryptionService.generate_secret()
    assert len(secret) == 32
    assert isinstance(secret, str)

    payload = {
        "type": "update_location",
        "data": {
            "latitude": 37.7749,
            "longitude": -122.4194,
            "battery": 90,
            "gps_accuracy": 10
        }
    }

    # Encrypt
    encrypted_b64 = EncryptionService.encrypt(secret, payload)
    assert isinstance(encrypted_b64, str)
    assert len(encrypted_b64) > 40

    # Decrypt
    decrypted = EncryptionService.decrypt(secret, encrypted_b64)
    assert decrypted == payload

    # Rejection of wrong secret
    other_secret = EncryptionService.generate_secret()
    with pytest.raises(ValueError, match="failed"):
        EncryptionService.decrypt(other_secret, encrypted_b64)

    # Rejection of invalid base64
    with pytest.raises(ValueError, match="Invalid Base64"):
        EncryptionService.decrypt(secret, "not_valid_base64!!!")

    # Rejection of payload too short
    with pytest.raises(ValueError, match="too short"):
        EncryptionService.decrypt(secret, "QUJD")

@pytest.mark.asyncio
async def test_first_registration_plaintext():
    """Test first registration with supports_encryption=False."""
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="user_plain", password="password123", display_name="Plain User"))
        token = create_jwt_token(data={"sub": str(user.id), "typ": "access"})
        headers = {"Authorization": f"Bearer {token}"}

    res = client.post("/api/mobile_app/registrations", headers=headers, json={
        "device_id": "pixel_plain_01",
        "app_id": "io.homeassistant.companion.android",
        "app_name": "Home Assistant",
        "app_version": "2026.1.0",
        "device_name": "Pixel Plain",
        "manufacturer": "Google",
        "model": "Pixel 8",
        "os_name": "Android",
        "os_version": "14",
        "supports_encryption": False,
        "app_data": {"push_token": "token_123"}
    })
    assert res.status_code == 201
    data = res.json()
    assert "webhook_id" in data
    assert data["secret"] is None
    assert data["cloudhook_url"] is None
    assert data["remote_ui_url"] is None

    webhook_id = data["webhook_id"]

    # Plaintext update_location works
    loc_res = client.post(f"/api/webhook/{webhook_id}", json={
        "type": "update_location",
        "data": {
            "latitude": 37.7749,
            "longitude": -122.4194,
            "gps_accuracy": 15.0,
            "battery": 95
        }
    })
    assert loc_res.status_code == 200

@pytest.mark.asyncio
async def test_first_registration_encrypted():
    """Test first registration with supports_encryption=True."""
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="user_enc", password="password123", display_name="Enc User"))
        token = create_jwt_token(data={"sub": str(user.id), "typ": "access"})
        headers = {"Authorization": f"Bearer {token}"}

    res = client.post("/api/mobile_app/registrations", headers=headers, json={
        "device_id": "iphone_enc_01",
        "app_id": "io.homeassistant.companion.ios",
        "app_name": "Home Assistant",
        "app_version": "2026.1.0",
        "device_name": "iPhone Encrypted",
        "manufacturer": "Apple",
        "model": "iPhone 15 Pro",
        "os_name": "iOS",
        "os_version": "17.4",
        "supports_encryption": True,
        "app_data": {"push_token": "apns_123"}
    })
    assert res.status_code == 201
    data = res.json()
    assert "webhook_id" in data
    assert data["secret"] is not None
    assert len(data["secret"]) == 32
    secret = data["secret"]
    webhook_id = data["webhook_id"]

    # Send encrypted location update
    loc_payload = {
        "type": "update_location",
        "data": {
            "latitude": 37.8000,
            "longitude": -122.4000,
            "gps_accuracy": 8.0,
            "battery": 82
        }
    }
    encrypted_b64 = EncryptionService.encrypt(secret, loc_payload)

    enc_res = client.post(f"/api/webhook/{webhook_id}", json={
        "type": "encrypted",
        "encrypted": True,
        "encrypted_data": encrypted_b64
    })
    assert enc_res.status_code == 200

    # Verify entity state in DB
    async with db_session_test_maker() as db:
        stmt = select(EntityState).where(EntityState.entity_id == "device_tracker.iphone_encrypted")
        res_entity = await db.execute(stmt)
        entity = res_entity.scalar_one_or_none()
        assert entity is not None
        assert entity.latitude == 37.8000
        assert entity.longitude == -122.4000

@pytest.mark.asyncio
async def test_same_user_re_registration():
    """Test same user re-registering the same device."""
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="same_user", password="password123", display_name="Same User"))
        token = create_jwt_token(data={"sub": str(user.id), "typ": "access"})
        headers = {"Authorization": f"Bearer {token}"}

    # Initial registration
    res1 = client.post("/api/mobile_app/registrations", headers=headers, json={
        "device_id": "same_dev_01",
        "app_id": "io.homeassistant.companion.android",
        "app_name": "Home Assistant",
        "app_version": "1.0.0",
        "device_name": "Old Device Name",
        "manufacturer": "Samsung",
        "model": "Galaxy S23",
        "os_name": "Android",
        "os_version": "13",
        "supports_encryption": True
    })
    assert res1.status_code == 201
    data1 = res1.json()
    webhook_1 = data1["webhook_id"]
    secret_1 = data1["secret"]

    # Re-registration with updated metadata
    res2 = client.post("/api/mobile_app/registrations", headers=headers, json={
        "device_id": "same_dev_01",
        "app_id": "io.homeassistant.companion.android",
        "app_name": "Home Assistant",
        "app_version": "2.0.0",
        "device_name": "Updated Device Name",
        "manufacturer": "Samsung",
        "model": "Galaxy S23",
        "os_name": "Android",
        "os_version": "14",
        "supports_encryption": True
    })
    assert res2.status_code == 201
    data2 = res2.json()
    assert data2["webhook_id"] == webhook_1
    secret_2 = data2["secret"]
    assert secret_2 is not None

    # Verify only ONE device record exists in DB (no duplicates)
    async with db_session_test_maker() as db:
        stmt = select(Device).where(Device.device_id == "same_dev_01")
        devices = (await db.execute(stmt)).scalars().all()
        assert len(devices) == 1
        assert devices[0].device_name == "Updated Device Name"
        assert devices[0].app_version == "2.0.0"

@pytest.mark.asyncio
async def test_cross_user_device_reassignment():
    """Test device reassignment from User A to User B."""
    async with db_session_test_maker() as db:
        user_a = await AuthService.create_user(db, UserCreate(username="user_a", password="password123", display_name="User A"))
        user_b = await AuthService.create_user(db, UserCreate(username="user_b", password="password123", display_name="User B"))
        token_a = create_jwt_token(data={"sub": str(user_a.id), "typ": "access"})
        token_b = create_jwt_token(data={"sub": str(user_b.id), "typ": "access"})
        headers_a = {"Authorization": f"Bearer {token_a}"}
        headers_b = {"Authorization": f"Bearer {token_b}"}

    # 1. User A registers physical device
    res_a = client.post("/api/mobile_app/registrations", headers=headers_a, json={
        "device_id": "shared_physical_device",
        "app_id": "io.homeassistant.companion",
        "app_name": "Home Assistant",
        "app_version": "1.0",
        "device_name": "User A Phone",
        "manufacturer": "Google",
        "model": "Pixel 7",
        "os_name": "Android",
        "os_version": "14",
        "supports_encryption": False
    })
    assert res_a.status_code == 201
    old_webhook = res_a.json()["webhook_id"]

    # User A sends location telemetry
    loc_a = client.post(f"/api/webhook/{old_webhook}", json={
        "type": "update_location",
        "data": {"latitude": 37.1111, "longitude": -122.1111, "battery": 90}
    })
    assert loc_a.status_code == 200

    # Verify User A has location history
    async with db_session_test_maker() as db:
        hist_a = (await db.execute(select(LocationHistory).where(LocationHistory.user_id == user_a.id))).scalars().all()
        assert len(hist_a) == 1

    # 2. User B registers SAME physical device_id (account switch)
    res_b = client.post("/api/mobile_app/registrations", headers=headers_b, json={
        "device_id": "shared_physical_device",
        "app_id": "io.homeassistant.companion",
        "app_name": "Home Assistant",
        "app_version": "1.0",
        "device_name": "User B Phone",
        "manufacturer": "Google",
        "model": "Pixel 7",
        "os_name": "Android",
        "os_version": "14",
        "supports_encryption": True
    })
    assert res_b.status_code == 201
    new_webhook = res_b.json()["webhook_id"]
    new_secret = res_b.json()["secret"]

    # Webhook ID MUST have changed
    assert new_webhook != old_webhook
    assert new_secret is not None

    # 3. Old webhook ID MUST return HTTP 410 Gone
    old_wh_res = client.post(f"/api/webhook/{old_webhook}", json={
        "type": "update_location",
        "data": {"latitude": 37.2222, "longitude": -122.2222}
    })
    assert old_wh_res.status_code == 410

    # 4. New webhook ID MUST work
    enc_payload = EncryptionService.encrypt(new_secret, {
        "type": "update_location",
        "data": {"latitude": 37.3333, "longitude": -122.3333, "battery": 80}
    })
    new_wh_res = client.post(f"/api/webhook/{new_webhook}", json={
        "type": "encrypted",
        "encrypted": True,
        "encrypted_data": enc_payload
    })
    assert new_wh_res.status_code == 200

    # 5. Verify database integrity
    async with db_session_test_maker() as db:
        # Exactly one device record in total
        devs = (await db.execute(select(Device).where(Device.device_id == "shared_physical_device"))).scalars().all()
        assert len(devs) == 1
        assert devs[0].user_id == user_b.id
        assert devs[0].device_name == "User B Phone"

        # Entity state is now owned by User B
        entity = (await db.execute(select(EntityState).where(EntityState.device_id == devs[0].id))).scalar_one_or_none()
        assert entity is not None
        assert entity.user_id == user_b.id
        assert entity.latitude == 37.3333

@pytest.mark.asyncio
async def test_multiple_devices_for_single_user():
    """Test registering multiple distinct devices for the same user."""
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="multi_dev_user", password="password123", display_name="Multi Dev"))
        token = create_jwt_token(data={"sub": str(user.id), "typ": "access"})
        headers = {"Authorization": f"Bearer {token}"}

    # Register Device 1 (Phone)
    res1 = client.post("/api/mobile_app/registrations", headers=headers, json={
        "device_id": "phone_device_01",
        "app_id": "io.homeassistant.companion",
        "app_name": "HA",
        "app_version": "1.0",
        "device_name": "My Phone",
        "manufacturer": "Apple",
        "model": "iPhone",
        "os_name": "iOS",
        "os_version": "17",
        "supports_encryption": False
    })
    assert res1.status_code == 201
    wh1 = res1.json()["webhook_id"]

    # Register Device 2 (Tablet)
    res2 = client.post("/api/mobile_app/registrations", headers=headers, json={
        "device_id": "tablet_device_02",
        "app_id": "io.homeassistant.companion",
        "app_name": "HA",
        "app_version": "1.0",
        "device_name": "My Tablet",
        "manufacturer": "Apple",
        "model": "iPad",
        "os_name": "iOS",
        "os_version": "17",
        "supports_encryption": True
    })
    assert res2.status_code == 201
    wh2 = res2.json()["webhook_id"]

    assert wh1 != wh2

    # Both webhooks can report telemetry independently
    r1 = client.post(f"/api/webhook/{wh1}", json={"type": "update_location", "data": {"latitude": 37.10, "longitude": -122.10}})
    assert r1.status_code == 200

    enc_tablet = EncryptionService.encrypt(res2.json()["secret"], {"type": "update_location", "data": {"latitude": 37.20, "longitude": -122.20}})
    r2 = client.post(f"/api/webhook/{wh2}", json={"type": "encrypted", "encrypted": True, "encrypted_data": enc_tablet})
    assert r2.status_code == 200

    # Verify both devices exist in DB for this user
    async with db_session_test_maker() as db:
        user_devs = (await db.execute(select(Device).where(Device.user_id == user.id))).scalars().all()
        assert len(user_devs) == 2

@pytest.mark.asyncio
async def test_enable_encryption_command():
    """Test enable_encryption webhook command."""
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="enable_enc_user", password="password123", display_name="Enable Enc"))
        token = create_jwt_token(data={"sub": str(user.id), "typ": "access"})
        headers = {"Authorization": f"Bearer {token}"}

    # Register with plaintext initially
    res = client.post("/api/mobile_app/registrations", headers=headers, json={
        "device_id": "enable_enc_device",
        "app_id": "io.homeassistant.companion",
        "app_name": "HA",
        "app_version": "1.0",
        "device_name": "Device",
        "manufacturer": "Google",
        "model": "Pixel",
        "os_name": "Android",
        "os_version": "14",
        "supports_encryption": False
    })
    wh = res.json()["webhook_id"]
    assert res.json()["secret"] is None

    # Call enable_encryption on webhook
    enable_res = client.post(f"/api/webhook/{wh}", json={"type": "enable_encryption"})
    assert enable_res.status_code == 200
    enable_data = enable_res.json()
    assert "secret" in enable_data
    new_secret = enable_data["secret"]
    assert len(new_secret) == 32

    # Subsequent request using encrypted payload succeeds
    enc = EncryptionService.encrypt(new_secret, {"type": "update_location", "data": {"latitude": 37.99, "longitude": -122.99}})
    res_enc = client.post(f"/api/webhook/{wh}", json={"type": "encrypted", "encrypted": True, "encrypted_data": enc})
    assert res_enc.status_code == 200
