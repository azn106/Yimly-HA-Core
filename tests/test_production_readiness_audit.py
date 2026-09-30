import asyncio
import os
import pytest
import pytest_asyncio
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from starlette.requests import Request
from starlette.exceptions import HTTPException

from app.main import app as fastapi_app
from app.db.database import Base, get_db
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService
from app.core.security import create_jwt_token
from app.db.models import Device, EntityState, LocationHistory, Circle, CircleMember, User, Alert
from app.schemas.telemetry import LocationUpdateData
from app.services.telemetry_service import TelemetryService
from app.services.event_service import event_bus
from app.api.circles import list_circle_members, create_circle
from app.api.traccar import get_traccar_location
from app.api.rest import api_delete_device, api_get_devices
from app.api.auth import delete_account

from sqlalchemy.pool import NullPool

AUDIT_DB_URL = "sqlite+aiosqlite:////tmp/test_yimly_audit.db"
audit_engine = create_async_engine(AUDIT_DB_URL, poolclass=NullPool, connect_args={"check_same_thread": False})
audit_session_maker = async_sessionmaker(bind=audit_engine, class_=AsyncSession, expire_on_commit=False)

@pytest_asyncio.fixture(autouse=True)
async def setup_audit_db():
    import app.db.database
    import app.api.websocket
    orig_session_maker = app.db.database.async_session_maker
    orig_ws_session_maker = getattr(app.api.websocket, "async_session_maker", None)

    app.db.database.async_session_maker = audit_session_maker
    app.api.websocket.async_session_maker = audit_session_maker

    async with audit_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    yield

    async with audit_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    app.db.database.async_session_maker = orig_session_maker
    if orig_ws_session_maker is not None:
        app.api.websocket.async_session_maker = orig_ws_session_maker

async def override_audit_get_db():
    async with audit_session_maker() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

fastapi_app.dependency_overrides[get_db] = override_audit_get_db

def to_utc(dt):
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


# =========================================================================
# 1 & 2. DATABASE SOURCE OF TRUTH & TRACCAR WRITE PATH & LOCATION FRESHNESS
# =========================================================================
@pytest.mark.asyncio
async def test_traccar_pipeline_and_location_freshness():
    async with audit_session_maker() as db:
        u1 = await AuthService.create_user(db, UserCreate(username="alice", password="password123", display_name="Alice"))
        u2 = await AuthService.create_user(db, UserCreate(username="bob", password="password123", display_name="Bob"))

        dev1 = Device(
            user_id=u1.id, device_id="alice_phone", device_name="Alice Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Apple", model="iPhone", os_name="iOS", os_version="17",
            supports_encryption=False, webhook_id="alice_traccar_token", webhook_secret_hash="fake"
        )
        dev2 = Device(
            user_id=u2.id, device_id="bob_phone", device_name="Bob Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Google", model="Pixel", os_name="Android", os_version="14",
            supports_encryption=False, webhook_id="bob_traccar_token", webhook_secret_hash="fake"
        )
        db.add_all([dev1, dev2])
        await db.commit()

        # Circle setup
        circle = Circle(name="Alice Circle", owner_id=u1.id, invite_code="ALICECIR")
        db.add(circle)
        await db.commit()
        await db.refresh(circle)
        cm1 = CircleMember(circle_id=circle.id, user_id=u1.id, display_name="Alice")
        cm2 = CircleMember(circle_id=circle.id, user_id=u2.id, display_name="Bob")
        db.add_all([cm1, cm2])
        await db.commit()

        fired_events = []
        def on_event(ev):
            fired_events.append(ev)
        unsub = event_bus.subscribe("state_changed", on_event)

        try:
            # Step 1: Alice posts fix A at 10:00
            fired_events.clear()
            epoch_10 = 1790800000 # 10:00
            time_10 = datetime.fromtimestamp(epoch_10, tz=timezone.utc)
            req_a = Request({"type": "http", "method": "GET", "query_string": f"id=alice&lat=-37.8100&lon=144.9600&timestamp={epoch_10}".encode()})
            res_a = await get_traccar_location(token=dev1.webhook_id, request=req_a, db=db)
            assert res_a.status_code == 200
            assert len(fired_events) == 1

            stmt = select(EntityState).where(EntityState.entity_id == "device_tracker.alice")
            es = (await db.execute(stmt)).scalar_one()
            assert es.latitude == -37.8100
            assert es.longitude == 144.9600
            assert to_utc(es.last_updated) == time_10

            # Step 2: Alice posts fix B at 11:00
            fired_events.clear()
            epoch_11 = 1790803600 # 11:00
            time_11 = datetime.fromtimestamp(epoch_11, tz=timezone.utc)
            req_b = Request({"type": "http", "method": "GET", "query_string": f"id=alice&lat=-37.8200&lon=144.9700&timestamp={epoch_11}".encode()})
            res_b = await get_traccar_location(token=dev1.webhook_id, request=req_b, db=db)
            assert res_b.status_code == 200
            assert len(fired_events) == 1

            es = (await db.execute(stmt)).scalar_one()
            assert es.latitude == -37.8200
            assert es.longitude == 144.9700
            assert to_utc(es.last_updated) == time_11

            # Step 3: Alice re-posts stale fix A (10:00)
            fired_events.clear()
            res_a2 = await get_traccar_location(token=dev1.webhook_id, request=req_a, db=db)
            assert res_a2.status_code == 200
            # Guard MUST block stale update from mutating EntityState and firing WebSocket event
            assert len(fired_events) == 0

            es = (await db.execute(stmt)).scalar_one()
            assert es.latitude == -37.8200
            assert es.longitude == 144.9700
            assert to_utc(es.last_updated) == time_11

            # LocationHistory retains all 3 telemetry entries
            stmt_h = select(LocationHistory).where(LocationHistory.user_id == u1.id)
            hist = (await db.execute(stmt_h)).scalars().all()
            assert len(hist) == 3

            # Circle Members API returns newest location B
            members = await list_circle_members(circle_id=circle.id, db=db, user=u1)
            mem_alice = next(m for m in members if m.username == "alice")
            assert mem_alice.devices[0].latitude == -37.8200
            assert mem_alice.devices[0].longitude == 144.9700

            # Step 4: Bob posts at 12:00 (Multi-user isolation)
            fired_events.clear()
            epoch_12 = 1790807200
            req_bob = Request({"type": "http", "method": "GET", "query_string": f"id=bob&lat=-33.8688&lon=151.2093&timestamp={epoch_12}".encode()})
            res_bob = await get_traccar_location(token=dev2.webhook_id, request=req_bob, db=db)
            assert res_bob.status_code == 200
            assert len(fired_events) == 1
            assert fired_events[0]["data"]["entity_id"] == "device_tracker.bob"

            # Alice's entity remains unchanged
            es = (await db.execute(stmt)).scalar_one()
            assert es.latitude == -37.8200

            stmt_bob = select(EntityState).where(EntityState.entity_id == "device_tracker.bob")
            es_bob = (await db.execute(stmt_bob)).scalar_one()
            assert es_bob.latitude == -33.8688

            # Step 5: Equal timestamp tie-breaker
            fired_events.clear()
            req_b_alt = Request({"type": "http", "method": "GET", "query_string": f"id=alice&lat=-37.8300&lon=144.9800&timestamp={epoch_11}".encode()})
            res_b_alt = await get_traccar_location(token=dev1.webhook_id, request=req_b_alt, db=db)
            assert res_b_alt.status_code == 200
            assert len(fired_events) == 1
            es = (await db.execute(stmt)).scalar_one()
            assert es.latitude == -37.8300
            assert es.longitude == 144.9800

        finally:
            unsub()


# =========================================================================
# 3. DEVICE LIFECYCLE & DELETION CLEANUP
# =========================================================================
@pytest.mark.asyncio
async def test_device_lifecycle_and_deletion_cleanup():
    async with audit_session_maker() as db:
        u1 = await AuthService.create_user(db, UserCreate(username="charlie", password="password123", display_name="Charlie"))
        u2 = await AuthService.create_user(db, UserCreate(username="dave", password="password123", display_name="Dave"))

        dev1 = Device(
            user_id=u1.id, device_id="charlie_phone", device_name="Charlie Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Apple", model="iPhone", os_name="iOS", os_version="17",
            supports_encryption=False, webhook_id="charlie_token", webhook_secret_hash="fake"
        )
        dev2 = Device(
            user_id=u2.id, device_id="dave_phone", device_name="Dave Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Google", model="Pixel", os_name="Android", os_version="14",
            supports_encryption=False, webhook_id="dave_token", webhook_secret_hash="fake"
        )
        db.add_all([dev1, dev2])
        await db.commit()

        # Ingest location telemetry for Charlie
        loc = LocationUpdateData(latitude=40.7128, longitude=-74.0060, timestamp=datetime.now(timezone.utc))
        await TelemetryService.process_location_update(db, dev1, loc)

        # Ingest location telemetry for Dave
        loc_dave = LocationUpdateData(latitude=34.0522, longitude=-118.2437, timestamp=datetime.now(timezone.utc))
        await TelemetryService.process_location_update(db, dev2, loc_dave)

        # Verify Charlie's device is in DB
        entity_id = "device_tracker.charlie"
        stmt_es = select(EntityState).where(EntityState.entity_id == entity_id)
        assert (await db.execute(stmt_es)).scalar_one_or_none() is not None

        # Verify LocationHistory exists
        stmt_h = select(LocationHistory).where(LocationHistory.device_id == dev1.id)
        assert len((await db.execute(stmt_h)).scalars().all()) >= 1

        # Attempt Cross-User Deletion: Dave tries to delete Charlie's device -> MUST FAIL (404)
        with pytest.raises(HTTPException) as exc_info:
            await api_delete_device(entity_id=entity_id, user=u2, db=db)
        assert exc_info.value.status_code == 404

        # Charlie deletes their own device -> MUST SUCCEED
        res_del = await api_delete_device(entity_id=entity_id, user=u1, db=db)
        assert res_del["success"] is True

        # Verify Database Cleanup:
        # 1. Device record is gone
        stmt_d = select(Device).where(Device.id == dev1.id)
        assert (await db.execute(stmt_d)).scalar_one_or_none() is None

        # 2. EntityState is gone
        assert (await db.execute(stmt_es)).scalar_one_or_none() is None

        # 3. LocationHistory for that device is gone
        assert len((await db.execute(stmt_h)).scalars().all()) == 0

        # 4. Device API for Charlie returns empty
        charlie_devices = await api_get_devices(user=u1, db=db)
        assert len(charlie_devices) == 0

        # 5. Deleted device can no longer post Traccar telemetry -> MUST 404
        req_post_deleted = Request({"type": "http", "method": "GET", "query_string": b"id=charlie&lat=40.7&lon=-74.0"})
        with pytest.raises(HTTPException) as tr_exc:
            await get_traccar_location(token=dev1.webhook_id, request=req_post_deleted, db=db)
        assert tr_exc.value.status_code == 404

        # 6. Dave's device and entity remain completely untouched
        stmt_dave_es = select(EntityState).where(EntityState.entity_id == "device_tracker.dave")
        assert (await db.execute(stmt_dave_es)).scalar_one_or_none() is not None
        dave_devices = await api_get_devices(user=u2, db=db)
        assert len(dave_devices) == 1


# =========================================================================
# 4. ACCOUNT DELETION
# =========================================================================
@pytest.mark.asyncio
async def test_account_deletion_end_to_end():
    async with audit_session_maker() as db:
        # Create users
        owner = await AuthService.create_user(db, UserCreate(username="emily", password="password123", display_name="Emily"))
        member = await AuthService.create_user(db, UserCreate(username="frank", password="password123", display_name="Frank"))

        # Create device and entity for Emily
        dev_emily = Device(
            user_id=owner.id, device_id="emily_phone", device_name="Emily Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Apple", model="iPhone", os_name="iOS", os_version="17",
            supports_encryption=False, webhook_id="emily_token", webhook_secret_hash="fake"
        )
        db.add(dev_emily)
        await db.commit()

        loc = LocationUpdateData(latitude=51.5074, longitude=-0.1278, timestamp=datetime.now(timezone.utc))
        await TelemetryService.process_location_update(db, dev_emily, loc)

        # Emily creates a circle with Frank
        circle = Circle(name="Emily Family", owner_id=owner.id, invite_code="EMILYFAM")
        db.add(circle)
        await db.commit()
        await db.refresh(circle)

        cm_emily = CircleMember(circle_id=circle.id, user_id=owner.id, display_name="Emily")
        cm_frank = CircleMember(circle_id=circle.id, user_id=member.id, display_name="Frank")
        db.add_all([cm_emily, cm_frank])
        await db.commit()

        # Emily deletes her own account
        res_del = await delete_account(current_user=owner, db=db)
        assert res_del["status"] == "success"

        # Verify Account Deletion Cleanup:
        # 1. User is deleted from DB
        stmt_u = select(User).where(User.id == owner.id)
        assert (await db.execute(stmt_u)).scalar_one_or_none() is None

        # 2. Devices for Emily are gone
        stmt_d = select(Device).where(Device.user_id == owner.id)
        assert (await db.execute(stmt_d)).scalar_one_or_none() is None

        # 3. Entities for Emily are gone
        stmt_e = select(EntityState).where(EntityState.entity_id == "device_tracker.emily")
        assert (await db.execute(stmt_e)).scalar_one_or_none() is None

        # 4. LocationHistory for Emily is gone
        stmt_h = select(LocationHistory).where(LocationHistory.user_id == owner.id)
        assert len((await db.execute(stmt_h)).scalars().all()) == 0

        # 5. Circle ownership transferred to Frank (no orphaned circle)
        stmt_c = select(Circle).where(Circle.id == circle.id)
        c_updated = (await db.execute(stmt_c)).scalar_one()
        assert c_updated.owner_id == member.id

        # 6. Emily is removed from Circle members
        stmt_members = select(CircleMember).where(CircleMember.circle_id == circle.id)
        remaining_members = (await db.execute(stmt_members)).scalars().all()
        assert len(remaining_members) == 1
        assert remaining_members[0].user_id == member.id

        # 7. Frank's account and data remain 100% intact
        stmt_frank = select(User).where(User.id == member.id)
        assert (await db.execute(stmt_frank)).scalar_one_or_none() is not None


# =========================================================================
# 5. MULTI-USER ISOLATION & AUTHORIZATION AUDIT
# =========================================================================
@pytest.mark.asyncio
async def test_cross_user_isolation():
    async with audit_session_maker() as db:
        user_x = await AuthService.create_user(db, UserCreate(username="user_x", password="password123", display_name="User X"))
        user_y = await AuthService.create_user(db, UserCreate(username="user_y", password="password123", display_name="User Y"))

        dev_x = Device(
            user_id=user_x.id, device_id="x_phone", device_name="X Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Apple", model="iPhone", os_name="iOS", os_version="17",
            supports_encryption=False, webhook_id="x_token", webhook_secret_hash="fake"
        )
        dev_y = Device(
            user_id=user_y.id, device_id="y_phone", device_name="Y Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Apple", model="iPhone", os_name="iOS", os_version="17",
            supports_encryption=False, webhook_id="y_token", webhook_secret_hash="fake"
        )
        db.add_all([dev_x, dev_y])
        await db.commit()

        loc_x = LocationUpdateData(latitude=1.23, longitude=4.56, timestamp=datetime.now(timezone.utc))
        await TelemetryService.process_location_update(db, dev_x, loc_x)

        # Test A: User Y cannot delete User X's device
        with pytest.raises(HTTPException) as exc_info:
            await api_delete_device(entity_id="device_tracker.user_x", user=user_y, db=db)
        assert exc_info.value.status_code == 404

        # Test B: Traccar ingestion: User Y cannot post to User X's token with User Y's username
        req_spoof = Request({"type": "http", "method": "GET", "query_string": b"id=user_y&lat=10.0&lon=20.0"})
        with pytest.raises(HTTPException) as exc_tr:
            await get_traccar_location(token=dev_x.webhook_id, request=req_spoof, db=db)
        assert exc_tr.value.status_code == 400
        assert "does not match expected username" in exc_tr.value.detail


# =========================================================================
# 7. RESTART & DATABASE PERSISTENCE AUDIT
# =========================================================================
@pytest.mark.asyncio
async def test_restart_persistence():
    # 1. Write data in session 1
    async with audit_session_maker() as db1:
        user_p = await AuthService.create_user(db1, UserCreate(username="persist_user", password="password123", display_name="Persist User"))
        dev_p = Device(
            user_id=user_p.id, device_id="p_phone", device_name="Persist Phone",
            app_id="yimly.app", app_name="Yimly", app_version="1.0",
            manufacturer="Google", model="Pixel", os_name="Android", os_version="14",
            supports_encryption=False, webhook_id="p_token", webhook_secret_hash="fake"
        )
        db1.add(dev_p)
        await db1.commit()

        fixed_time = datetime(2026, 9, 30, 8, 30, 0, tzinfo=timezone.utc)
        loc = LocationUpdateData(latitude=-31.9505, longitude=115.8605, timestamp=fixed_time)
        await TelemetryService.process_location_update(db1, dev_p, loc)

    # 2. Simulate complete restart by opening a fresh database session
    async with audit_session_maker() as db2:
        # Verify user persisted
        stmt_u = select(User).where(User.username == "persist_user")
        res_u = (await db2.execute(stmt_u)).scalar_one_or_none()
        assert res_u is not None
        assert res_u.display_name == "Persist User"

        # Verify device persisted
        stmt_d = select(Device).where(Device.device_id == "p_phone")
        res_d = (await db2.execute(stmt_d)).scalar_one_or_none()
        assert res_d is not None
        assert res_d.webhook_id == "p_token"

        # Verify entity state persisted
        stmt_e = select(EntityState).where(EntityState.entity_id == "device_tracker.persist_user")
        res_e = (await db2.execute(stmt_e)).scalar_one_or_none()
        assert res_e is not None
        assert res_e.latitude == -31.9505
        assert res_e.longitude == 115.8605
        assert to_utc(res_e.last_updated) == fixed_time

        # Verify location history persisted
        stmt_h = select(LocationHistory).where(LocationHistory.user_id == res_u.id)
        hist = (await db2.execute(stmt_h)).scalars().all()
        assert len(hist) >= 1
        assert hist[0].latitude == -31.9505
