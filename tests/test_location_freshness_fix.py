import asyncio
import os
import pytest
import pytest_asyncio
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from starlette.requests import Request
from app.main import app as fastapi_app
from app.db.database import Base, get_db
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService
from app.core.security import create_jwt_token
from app.db.models import Device, EntityState, LocationHistory, Circle, CircleMember
from app.schemas.telemetry import LocationUpdateData
from app.services.telemetry_service import TelemetryService
from app.services.event_service import event_bus
from app.api.circles import list_circle_members
from app.api.traccar import get_traccar_location

TEST_DATABASE_URL = "sqlite+aiosqlite:////tmp/test_ha_location_freshness.db"
test_engine = create_async_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
db_session_test_maker = async_sessionmaker(bind=test_engine, class_=AsyncSession, expire_on_commit=False)

@pytest_asyncio.fixture(autouse=True)
async def setup_test_db():
    import app.db.database
    import app.api.websocket
    orig_session_maker = app.db.database.async_session_maker
    orig_ws_session_maker = getattr(app.api.websocket, "async_session_maker", None)

    app.db.database.async_session_maker = db_session_test_maker
    app.api.websocket.async_session_maker = db_session_test_maker

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    yield

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    app.db.database.async_session_maker = orig_session_maker
    if orig_ws_session_maker is not None:
        app.api.websocket.async_session_maker = orig_ws_session_maker

    for db_file in ["/tmp/test_ha_location_freshness.db", "/tmp/test_ha_location_freshness.db-shm", "/tmp/test_ha_location_freshness.db-wal"]:
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

fastapi_app.dependency_overrides[get_db] = override_get_db

@pytest.mark.asyncio
async def test_location_freshness_and_ordering():
    async with db_session_test_maker() as db:
        # 1. Create test users
        user_a_in = UserCreate(username="usera", password="password123", display_name="User A")
        user_b_in = UserCreate(username="userb", password="password123", display_name="User B")
        user_a = await AuthService.create_user(db, user_a_in)
        user_b = await AuthService.create_user(db, user_b_in)

        # 2. Create devices for users with all required non-null fields
        device_a = Device(
            user_id=user_a.id,
            device_id="usera_device",
            device_name="User A Phone",
            app_id="usera_app",
            app_name="YimlyApp",
            app_version="1.0.0",
            manufacturer="Apple",
            model="iPhone 14",
            os_name="iOS",
            os_version="17.0",
            supports_encryption=False,
            webhook_id="usera_token",
            webhook_secret_hash="fake_hash"
        )
        device_b = Device(
            user_id=user_b.id,
            device_id="userb_device",
            device_name="User B Phone",
            app_id="userb_app",
            app_name="YimlyApp",
            app_version="1.0.0",
            manufacturer="Google",
            model="Pixel 8",
            os_name="Android",
            os_version="14.0",
            supports_encryption=False,
            webhook_id="userb_token",
            webhook_secret_hash="fake_hash"
        )
        db.add_all([device_a, device_b])
        await db.commit()

        webhook_id_a = device_a.webhook_id

        # 3. Create Circle and Members
        circle = Circle(name="The Test Circle", owner_id=user_a.id, invite_code="TESTCODE")
        db.add(circle)
        await db.commit()
        await db.refresh(circle)

        cm_a = CircleMember(circle_id=circle.id, user_id=user_a.id, display_name="User A")
        cm_b = CircleMember(circle_id=circle.id, user_id=user_b.id, display_name="User B")
        db.add_all([cm_a, cm_b])
        await db.commit()

        # Listen to event_bus to track state_changed events
        fired_events = []
        def on_state_changed(event):
            fired_events.append(event)

        unsubscribe = event_bus.subscribe("state_changed", on_state_changed)

        def to_utc(dt):
            if dt is None:
                return None
            return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt

        try:
            # Coordinates and timestamps
            time_10 = datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)
            time_11 = datetime(2026, 9, 30, 11, 0, 0, tzinfo=timezone.utc)

            # ---------------------------------------------------------
            # TEST A -> B -> A (Stale A arrives after B)
            # ---------------------------------------------------------
            # Step 1: Process A (10:00)
            fired_events.clear()
            loc_a_10 = LocationUpdateData(
                latitude=-38.1000,
                longitude=145.1000,
                gps_accuracy=5.0,
                timestamp=time_10
            )
            await TelemetryService.process_location_update(db, device_a, loc_a_10)

            stmt = select(EntityState).where(EntityState.entity_id == "device_tracker.usera")
            res = await db.execute(stmt)
            es_a = res.scalar_one()
            assert es_a.latitude == -38.1000
            assert es_a.longitude == 145.1000
            assert to_utc(es_a.last_updated) == time_10
            assert len(fired_events) == 1

            # Step 2: Process B (11:00)
            fired_events.clear()
            loc_a_11 = LocationUpdateData(
                latitude=-38.2000,
                longitude=145.2000,
                gps_accuracy=10.0,
                timestamp=time_11
            )
            await TelemetryService.process_location_update(db, device_a, loc_a_11)

            res = await db.execute(stmt)
            es_a = res.scalar_one()
            assert es_a.latitude == -38.2000
            assert es_a.longitude == 145.2000
            assert to_utc(es_a.last_updated) == time_11
            assert len(fired_events) == 1

            # Step 3: Process A (10:00) AGAIN (Out-of-order stale update)
            fired_events.clear()
            await TelemetryService.process_location_update(db, device_a, loc_a_10)

            # Verification:
            # - EntityState remains coordinates B
            # - EntityState timestamp remains 11:00
            # - EntityState last_updated does NOT become server receipt time for A
            res = await db.execute(stmt)
            es_a = res.scalar_one()
            assert es_a.latitude == -38.2000
            assert es_a.longitude == 145.2000
            assert to_utc(es_a.last_updated) == time_11
            # - No state_changed WebSocket event generated for stale A
            assert len(fired_events) == 0

            # - LocationHistory still contains A
            stmt_hist = select(LocationHistory).where(LocationHistory.user_id == user_a.id)
            res_hist = await db.execute(stmt_hist)
            hist_records = res_hist.scalars().all()
            assert len(hist_records) >= 3
            time_10_count = sum(1 for h in hist_records if h.latitude == -38.1000)
            assert time_10_count >= 2

            # - Circle members API still returns B
            members_data = await list_circle_members(circle_id=circle.id, db=db, user=user_a)
            mem_a = next(m for m in members_data if m.username == "usera")
            assert mem_a.devices[0].latitude == -38.2000
            assert mem_a.devices[0].longitude == 145.2000
            assert mem_a.devices[0].last_updated.startswith("2026-09-30T11:00:00")

            # ---------------------------------------------------------
            # TEST B -> A (Where B is processed FIRST, and older A arrives later)
            # ---------------------------------------------------------
            # We test on User B:
            fired_events.clear()
            time_b_newer = datetime(2026, 9, 30, 14, 0, 0, tzinfo=timezone.utc)
            time_b_older = datetime(2026, 9, 30, 12, 0, 0, tzinfo=timezone.utc)

            loc_b_newer = LocationUpdateData(
                latitude=-33.8688,
                longitude=151.2093,
                gps_accuracy=5.0,
                timestamp=time_b_newer
            )
            await TelemetryService.process_location_update(db, device_b, loc_b_newer)

            stmt_b = select(EntityState).where(EntityState.entity_id == "device_tracker.userb")
            res_b = await db.execute(stmt_b)
            es_b = res_b.scalar_one()
            assert es_b.latitude == -33.8688
            assert to_utc(es_b.last_updated) == time_b_newer
            assert len(fired_events) == 1

            # Older A arrives later
            fired_events.clear()
            loc_b_older = LocationUpdateData(
                latitude=-37.8136,
                longitude=144.9631,
                gps_accuracy=8.0,
                timestamp=time_b_older
            )
            await TelemetryService.process_location_update(db, device_b, loc_b_older)

            res_b = await db.execute(stmt_b)
            es_b = res_b.scalar_one()
            # Must remain newer coordinates and newer timestamp
            assert es_b.latitude == -33.8688
            assert es_b.longitude == 151.2093
            assert to_utc(es_b.last_updated) == time_b_newer
            # Must NOT fire event
            assert len(fired_events) == 0

            # ---------------------------------------------------------
            # TEST EQUAL TIMESTAMPS TIE-BREAKER
            # ---------------------------------------------------------
            fired_events.clear()
            loc_a_11_alt = LocationUpdateData(
                latitude=-38.3000,
                longitude=145.3000,
                gps_accuracy=15.0,
                timestamp=time_11
            )
            await TelemetryService.process_location_update(db, device_a, loc_a_11_alt)

            # Equal timestamp is accepted (>= rule) and fires state change
            res = await db.execute(stmt)
            es_a = res.scalar_one()
            assert es_a.latitude == -38.3000
            assert es_a.longitude == 145.3000
            assert to_utc(es_a.last_updated) == time_11
            assert len(fired_events) == 1

            # ---------------------------------------------------------
            # TEST TRACCAR ENDPOINT DIRECTLY (app/api/traccar.py HTTP path)
            # ---------------------------------------------------------
            # Send newer Traccar fix via GET at 15:00
            epoch_15 = 1790805000  # 15:00
            req_newer = Request({"type": "http", "method": "GET", "query_string": f"id=usera&lat=-38.4444&lon=145.4444&timestamp={epoch_15}".encode()})
            fired_events.clear()
            resp_newer = await get_traccar_location(token=webhook_id_a, request=req_newer, db=db)
            assert resp_newer.status_code == 200

            res = await db.execute(stmt)
            es_a = res.scalar_one()
            assert es_a.latitude == -38.4444
            assert es_a.longitude == 145.4444
            assert len(fired_events) == 1

            # Send older Traccar fix via GET (stale epoch: 10:00)
            epoch_10 = 1790800000  # 10:00
            req_stale = Request({"type": "http", "method": "GET", "query_string": f"id=usera&lat=-38.9999&lon=145.9999&timestamp={epoch_10}".encode()})
            fired_events.clear()
            resp_stale = await get_traccar_location(token=webhook_id_a, request=req_stale, db=db)
            assert resp_stale.status_code == 200

            # EntityState must remain unchanged at -38.4444
            res = await db.execute(stmt)
            es_a = res.scalar_one()
            assert es_a.latitude == -38.4444
            assert es_a.longitude == 145.4444
            # Stale update must NOT trigger state change event
            assert len(fired_events) == 0

        finally:
            unsubscribe()
