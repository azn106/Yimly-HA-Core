import asyncio
import os
import pytest
import pytest_asyncio
from datetime import datetime, timezone, timedelta
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from starlette.requests import Request

from app.main import app as fastapi_app
from app.db.database import Base, get_db
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService
from app.db.models import Device, EntityState, LocationHistory, Circle, CircleMember
from app.schemas.telemetry import LocationUpdateData
from app.services.telemetry_service import TelemetryService
from app.services.state_service import StateService, normalize_utc_datetime, safe_isoformat
from app.services.event_service import event_bus
from app.api.circles import list_circle_members
from app.api.traccar import get_traccar_location, post_traccar_location, ensure_traccar_device_for_user

TEST_DATABASE_URL = "sqlite+aiosqlite:////tmp/test_ha_location_freshness.db"
test_engine = create_async_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
db_session_test_maker = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)

async def override_get_db():
    async with db_session_test_maker() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

@pytest_asyncio.fixture(autouse=True)
async def setup_test_db():
    import app.db.database
    import app.api.websocket
    orig_session_maker = app.db.database.async_session_maker
    orig_ws_session_maker = getattr(app.api.websocket, "async_session_maker", None)

    app.db.database.async_session_maker = db_session_test_maker
    app.api.websocket.async_session_maker = db_session_test_maker
    fastapi_app.dependency_overrides[get_db] = override_get_db

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    yield

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    app.db.database.async_session_maker = orig_session_maker
    if orig_ws_session_maker is not None:
        app.api.websocket.async_session_maker = orig_ws_session_maker


def to_utc(dt):
    if dt is None:
        return None
    if isinstance(dt, str):
        dt = normalize_utc_datetime(dt)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


# =====================================================================
# TEST 1: Newer -> Older (Stale fix arrives after newer fix)
# =====================================================================
@pytest.mark.asyncio
async def test_freshness_newer_then_older():
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="fresh_user1", password="password123", display_name="User One"))
        device = Device(
            user_id=user.id, device_id="device1", device_name="User One Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Apple", model="iPhone", os_name="iOS", os_version="17.0",
            supports_encryption=False, webhook_id="token_u1", webhook_secret_hash="fake"
        )
        db.add(device)
        await db.commit()

        fired_events = []
        def on_event(event):
            fired_events.append(event)
        unsub = event_bus.subscribe("state_changed", on_event)

        try:
            time_11 = datetime(2026, 9, 30, 11, 0, 0, tzinfo=timezone.utc)
            time_10 = datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)

            # Step 1: Send newer fix (11:00, Location B)
            loc_b = LocationUpdateData(latitude=37.7749, longitude=-122.4194, gps_accuracy=5.0, timestamp=time_11)
            await TelemetryService.process_location_update(db, device, loc_b)

            
            stmt = select(EntityState).where(EntityState.entity_id == "device_tracker.fresh_user1")
            res = await db.execute(stmt)
            entity = res.scalar_one()
            assert entity.latitude == 37.7749
            assert entity.longitude == -122.4194
            assert to_utc(entity.last_updated) == time_11
            assert len(fired_events) == 1

            # Step 2: Send older fix (10:00, Location A)
            fired_events.clear()
            loc_a = LocationUpdateData(latitude=34.0522, longitude=-118.2437, gps_accuracy=10.0, timestamp=time_10)
            await TelemetryService.process_location_update(db, device, loc_a)

            # Assertions:
            # - EntityState remains Location B
            # - EntityState timestamp remains 11:00
            # - No stale WebSocket event fired
            
            res = await db.execute(stmt)
            entity = res.scalar_one()
            assert entity.latitude == 37.7749
            assert entity.longitude == -122.4194
            assert to_utc(entity.last_updated) == time_11
            assert len(fired_events) == 0

            # - LocationHistory contains BOTH fixes with original timestamps
            stmt_h = select(LocationHistory).where(LocationHistory.user_id == user.id)
            res_h = await db.execute(stmt_h)
            history = res_h.scalars().all()
            assert len(history) == 2
            timestamps = [to_utc(h.timestamp) for h in history]
            assert time_11 in timestamps
            assert time_10 in timestamps
        finally:
            unsub()


# =====================================================================
# TEST 2: Older -> Newer (Chronological in-order updates)
# =====================================================================
@pytest.mark.asyncio
async def test_freshness_older_then_newer():
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="fresh_user2", password="password123", display_name="User Two"))
        device = Device(
            user_id=user.id, device_id="device2", device_name="User Two Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Google", model="Pixel", os_name="Android", os_version="14",
            supports_encryption=False, webhook_id="token_u2", webhook_secret_hash="fake"
        )
        db.add(device)
        await db.commit()

        time_10 = datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)
        time_11 = datetime(2026, 9, 30, 11, 0, 0, tzinfo=timezone.utc)

        # Receive 10:00 (A)
        loc_a = LocationUpdateData(latitude=40.7128, longitude=-74.0060, gps_accuracy=5.0, timestamp=time_10)
        await TelemetryService.process_location_update(db, device, loc_a)

        
        stmt = select(EntityState).where(EntityState.entity_id == "device_tracker.fresh_user2")
        res = await db.execute(stmt)
        entity = res.scalar_one()
        assert entity.latitude == 40.7128
        assert to_utc(entity.last_updated) == time_10

        # Receive 11:00 (B)
        loc_b = LocationUpdateData(latitude=42.3601, longitude=-71.0589, gps_accuracy=5.0, timestamp=time_11)
        await TelemetryService.process_location_update(db, device, loc_b)

        
        res = await db.execute(stmt)
        entity = res.scalar_one()
        assert entity.latitude == 42.3601
        assert to_utc(entity.last_updated) == time_11

        # Verify history has both
        stmt_h = select(LocationHistory).where(LocationHistory.user_id == user.id)
        history = (await db.execute(stmt_h)).scalars().all()
        assert len(history) == 2


# =====================================================================
# TEST 3: Equal Timestamps
# =====================================================================
@pytest.mark.asyncio
async def test_freshness_equal_timestamps():
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="fresh_user3", password="password123", display_name="User Three"))
        device = Device(
            user_id=user.id, device_id="device3", device_name="User Three Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Samsung", model="Galaxy", os_name="Android", os_version="14",
            supports_encryption=False, webhook_id="token_u3", webhook_secret_hash="fake"
        )
        db.add(device)
        await db.commit()

        time_12 = datetime(2026, 9, 30, 12, 0, 0, tzinfo=timezone.utc)
        loc_1 = LocationUpdateData(latitude=51.5074, longitude=-0.1278, gps_accuracy=5.0, timestamp=time_12)
        await TelemetryService.process_location_update(db, device, loc_1)

        loc_2 = LocationUpdateData(latitude=51.5075, longitude=-0.1279, gps_accuracy=5.0, timestamp=time_12)
        await TelemetryService.process_location_update(db, device, loc_2)

        
        stmt = select(EntityState).where(EntityState.entity_id == "device_tracker.fresh_user3")
        entity = (await db.execute(stmt)).scalar_one()
        assert entity.latitude == 51.5075
        assert to_utc(entity.last_updated) == time_12


# =====================================================================
# TEST 4: SQLite string and naive datetimes handling
# =====================================================================
@pytest.mark.asyncio
async def test_sqlite_string_and_naive_datetimes():
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="fresh_user4", password="password123", display_name="User Four"))

        # Test ISO string normalization
        assert normalize_utc_datetime("2026-09-30T10:00:00Z") == datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)
        assert normalize_utc_datetime("2026-09-30T10:00:00+00:00") == datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)
        # Test naive datetime normalization
        naive_dt = datetime(2026, 9, 30, 10, 0, 0)
        assert normalize_utc_datetime(naive_dt) == datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)
        # Test None
        assert normalize_utc_datetime(None) is None

        # Test safe_isoformat
        assert safe_isoformat(naive_dt) == "2026-09-30T10:00:00"
        assert safe_isoformat("2026-09-30T10:00:00Z") == "2026-09-30T10:00:00Z"
        assert safe_isoformat(None, fallback="fallback_val") == "fallback_val"

        # Direct StateService call with string timestamp
        res1 = await StateService.set_state(
            db=db, user_id=user.id, entity_id="device_tracker.fresh_user4",
            state="not_home", attributes={"friendly_name": "Test Phone"},
            latitude=10.0, longitude=20.0, timestamp="2026-09-30T10:00:00Z" # type: ignore
        )
        assert res1.latitude == 10.0
        assert to_utc(res1.last_updated) == datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)

        # Send older timestamp as string -> rejected safely without TypeError/AttributeError
        res2 = await StateService.set_state(
            db=db, user_id=user.id, entity_id="device_tracker.fresh_user4",
            state="not_home", attributes={"friendly_name": "Test Phone"},
            latitude=5.0, longitude=5.0, timestamp="2026-09-30T09:00:00Z" # type: ignore
        )
        assert res2.latitude == 10.0


# =====================================================================
# TEST 5: Missing timestamp
# =====================================================================
@pytest.mark.asyncio
async def test_missing_timestamp_safe_defaults():
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="fresh_user5", password="password123", display_name="User Five"))
        device = Device(
            user_id=user.id, device_id="device5", device_name="User Five Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Apple", model="iPhone", os_name="iOS", os_version="17.0",
            supports_encryption=False, webhook_id="token_u5", webhook_secret_hash="fake"
        )
        db.add(device)
        await db.commit()

        # LocationUpdateData with timestamp=None
        loc = LocationUpdateData(latitude=48.8566, longitude=2.3522, gps_accuracy=5.0, timestamp=None)
        await TelemetryService.process_location_update(db, device, loc)

        
        stmt = select(EntityState).where(EntityState.entity_id == "device_tracker.fresh_user5")
        entity = (await db.execute(stmt)).scalar_one()
        assert entity.latitude == 48.8566
        assert entity.last_updated is not None


# =====================================================================
# TEST 6: Multi-user isolation
# =====================================================================
@pytest.mark.asyncio
async def test_multi_user_isolation():
    async with db_session_test_maker() as db:
        user_a = await AuthService.create_user(db, UserCreate(username="iso_user_a", password="password123", display_name="User A"))
        user_b = await AuthService.create_user(db, UserCreate(username="iso_user_b", password="password123", display_name="User B"))

        dev_a = Device(
            user_id=user_a.id, device_id="iso_dev_a", device_name="User A Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Apple", model="iPhone", os_name="iOS", os_version="17.0",
            supports_encryption=False, webhook_id="token_iso_a", webhook_secret_hash="fake"
        )
        dev_b = Device(
            user_id=user_b.id, device_id="iso_dev_b", device_name="User B Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Google", model="Pixel", os_name="Android", os_version="14",
            supports_encryption=False, webhook_id="token_iso_b", webhook_secret_hash="fake"
        )
        db.add_all([dev_a, dev_b])
        await db.commit()

        time_now = datetime(2026, 9, 30, 15, 0, 0, tzinfo=timezone.utc)
        await TelemetryService.process_location_update(db, dev_a, LocationUpdateData(latitude=1.1, longitude=1.1, timestamp=time_now))
        await TelemetryService.process_location_update(db, dev_b, LocationUpdateData(latitude=2.2, longitude=2.2, timestamp=time_now))

        
        # Verify A
        stmt_a = select(EntityState).where(EntityState.entity_id == "device_tracker.iso_user_a")
        es_a = (await db.execute(stmt_a)).scalar_one()
        assert es_a.latitude == 1.1
        assert es_a.user_id == user_a.id

        # Verify B
        stmt_b = select(EntityState).where(EntityState.entity_id == "device_tracker.iso_user_b")
        es_b = (await db.execute(stmt_b)).scalar_one()
        assert es_b.latitude == 2.2
        assert es_b.user_id == user_b.id

        # Histories are completely isolated
        hist_a = (await db.execute(select(LocationHistory).where(LocationHistory.user_id == user_a.id))).scalars().all()
        hist_b = (await db.execute(select(LocationHistory).where(LocationHistory.user_id == user_b.id))).scalars().all()
        assert len(hist_a) == 1
        assert len(hist_b) == 1
        assert hist_a[0].latitude == 1.1
        assert hist_b[0].latitude == 2.2


# =====================================================================
# TEST 7: WebSocket event broadcast rules
# =====================================================================
@pytest.mark.asyncio
async def test_websocket_broadcast_rules():
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="ws_user", password="password123", display_name="WS User"))
        dev = Device(
            user_id=user.id, device_id="ws_dev", device_name="WS Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Apple", model="iPhone", os_name="iOS", os_version="17.0",
            supports_encryption=False, webhook_id="ws_token", webhook_secret_hash="fake"
        )
        db.add(dev)
        await db.commit()

        events = []
        def on_event(ev):
            events.append(ev)
        unsub = event_bus.subscribe("state_changed", on_event)

        try:
            t1 = datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)
            t2 = datetime(2026, 9, 30, 9, 0, 0, tzinfo=timezone.utc)

            # Newer fix emits event
            events.clear()
            await TelemetryService.process_location_update(db, dev, LocationUpdateData(latitude=10.0, longitude=10.0, timestamp=t1))
            assert len(events) == 1
            assert events[0]["data"]["new_state"]["attributes"]["latitude"] == 10.0

            # Stale fix does NOT emit event
            events.clear()
            await TelemetryService.process_location_update(db, dev, LocationUpdateData(latitude=5.0, longitude=5.0, timestamp=t2))
            assert len(events) == 0
        finally:
            unsub()


# =====================================================================
# TEST 8: Real Traccar API path
# =====================================================================
@pytest.mark.asyncio
async def test_real_traccar_api_path():
    async with db_session_test_maker() as db:
        user = await AuthService.create_user(db, UserCreate(username="traccar_prod_user", password="password123", display_name="Traccar User"))
        device = await ensure_traccar_device_for_user(db, user)
        token = device.webhook_id

        now_epoch = int(datetime.now(timezone.utc).timestamp())
        ts_newer = now_epoch
        ts_older = now_epoch - 18000 # 5 hours earlier

        # 1. GET request with newer fix
        req_newer = Request({"type": "http", "method": "GET", "query_string": f"id=traccar_prod_user&lat=37.7749&lon=-122.4194&timestamp={ts_newer}&speed=5.2&batt=90".encode()})
        resp_newer = await get_traccar_location(token=token, request=req_newer, db=db)
        assert resp_newer.status_code == 200

        
        stmt = select(EntityState).where(EntityState.entity_id == "device_tracker.traccar_prod_user")
        entity = (await db.execute(stmt)).scalar_one()
        assert entity.latitude == 37.7749
        assert entity.longitude == -122.4194

        # 2. POST request with stale fix
        req_older = Request({"type": "http", "method": "POST", "query_string": f"id=traccar_prod_user&lat=34.0522&lon=-118.2437&timestamp={ts_older}&speed=2.1&batt=85".encode()})
        resp_older = await post_traccar_location(token=token, request=req_older, db=db)
        assert resp_older.status_code == 200

        # Current EntityState remains 37.7749 (newer 15:00 fix)
        await db.refresh(entity)
        assert entity.latitude == 37.7749
        assert entity.longitude == -122.4194

        # History has BOTH fixes
        history = (await db.execute(select(LocationHistory).where(LocationHistory.user_id == user.id))).scalars().all()
        assert len(history) == 2
