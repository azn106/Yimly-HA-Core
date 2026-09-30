import asyncio
import os
import pytest
from datetime import datetime, timezone
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from app.main import app
from app.db.database import Base, get_db
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService
from app.core.security import create_jwt_token
from app.db.models import Device, EntityState, LocationHistory, Circle, CircleMember
from app.schemas.telemetry import LocationUpdateData
from app.services.telemetry_service import TelemetryService
from app.services.state_service import StateService

TEST_DATABASE_URL = "sqlite+aiosqlite:////tmp/test_ha_location_freshness.db"
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

app.dependency_overrides[get_db] = override_get_db
client = TestClient(app)

@pytest.mark.asyncio
async def test_location_freshness_and_ordering():
    async with db_session_test_maker() as db:
        # Create test users
        user_a_in = UserCreate(username="usera", password="password123", display_name="User A")
        user_b_in = UserCreate(username="userb", password="password123", display_name="User B")
        user_a = await AuthService.create_user(db, user_a_in)
        user_b = await AuthService.create_user(db, user_b_in)

        # Create device for User A
        device_a = Device(
            user_id=user_a.id,
            device_id="usera_device",
            device_name="User A Phone",
            webhook_id="usera_token",
            app_id="usera_app"
        )
        # Create device for User B
        device_b = Device(
            user_id=user_b.id,
            device_id="userb_device",
            device_name="User B Phone",
            webhook_id="userb_token",
            app_id="userb_app"
        )
        db.add_all([device_a, device_b])
        await db.commit()

        # Build circles to verify circles API behavior
        circle = Circle(name="The Test Circle", owner_id=user_a.id, invite_code="TESTCODE")
        db.add(circle)
        await db.commit()
        await db.refresh(circle)

        cm_a = CircleMember(circle_id=circle.id, user_id=user_a.id, display_name="User A", is_owner=True)
        cm_b = CircleMember(circle_id=circle.id, user_id=user_b.id, display_name="User B", is_owner=False)
        db.add_all([cm_a, cm_b])
        await db.commit()

        # Timestamps for points
        time_10 = datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)
        time_11 = datetime(2026, 9, 30, 11, 0, 0, tzinfo=timezone.utc)

        # ---------------------------------------------------------
        # TEST 1: NEWER THEN OLDER
        # ---------------------------------------------------------
        # Send Point A (10:00) for User A
        loc_a_10 = LocationUpdateData(
            latitude=-38.1000,
            longitude=145.1000,
            gps_accuracy=5.0,
            timestamp=time_10
        )
        await TelemetryService.process_location_update(db, device_a, loc_a_10)

        # Verify initial state
        stmt = select(EntityState).where(EntityState.entity_id == "device_tracker.usera")
        res = await db.execute(stmt)
        es_a = res.scalar_one()
        assert es_a.latitude == -38.1000
        assert es_a.longitude == 145.1000
        assert es_a.last_updated == time_10

        # Send Point B (11:00) for User A
        loc_a_11 = LocationUpdateData(
            latitude=-38.2000,
            longitude=145.2000,
            gps_accuracy=10.0,
            timestamp=time_11
        )
        await TelemetryService.process_location_update(db, device_a, loc_a_11)

        # Verify updated state (newer fix is accepted)
        db.expire_all()
        res = await db.execute(stmt)
        es_a = res.scalar_one()
        assert es_a.latitude == -38.2000
        assert es_a.longitude == 145.2000
        assert es_a.last_updated == time_11

        # Send Point A (10:00) AGAIN for User A (buffered out-of-order)
        await TelemetryService.process_location_update(db, device_a, loc_a_10)

        # Verify state is NOT overwritten (Coords remain at Point B)
        db.expire_all()
        res = await db.execute(stmt)
        es_a = res.scalar_one()
        assert es_a.latitude == -38.2000
        assert es_a.longitude == 145.2000
        assert es_a.last_updated == time_11  # Timestamp must remain 11:00

        # ---------------------------------------------------------
        # TEST 2: HISTORY PRESERVATION
        # ---------------------------------------------------------
        # Verify that LocationHistory retained all entries with correct timestamps
        stmt_hist = select(LocationHistory).where(LocationHistory.user_id == user_a.id)
        res_hist = await db.execute(stmt_hist)
        hist_records = res_hist.scalars().all()
        assert len(hist_records) >= 3

        # One record should have time_10, another time_11
        has_time_10 = any(h.timestamp == time_10 for h in hist_records)
        has_time_11 = any(h.timestamp == time_11 for h in hist_records)
        assert has_time_10 is True
        assert has_time_11 is True

        # ---------------------------------------------------------
        # TEST 3: EQUAL TIMESTAMP TIE-BREAKER
        # ---------------------------------------------------------
        # Process another coordinate with equal timestamp (11:00)
        loc_a_11_alt = LocationUpdateData(
            latitude=-38.3000,
            longitude=145.3000,
            gps_accuracy=15.0,
            timestamp=time_11
        )
        await TelemetryService.process_location_update(db, device_a, loc_a_11_alt)

        # Equal timestamp should overwrite (standard tie-break behaviour)
        db.expire_all()
        res = await db.execute(stmt)
        es_a = res.scalar_one()
        assert es_a.latitude == -38.3000
        assert es_a.longitude == 145.3000

        # ---------------------------------------------------------
        # TEST 4: MULTI-USER ISOLATION
        # ---------------------------------------------------------
        # Send newer point for User B at 11:00
        loc_b_11 = LocationUpdateData(
            latitude=-40.0000,
            longitude=140.0000,
            gps_accuracy=5.0,
            timestamp=time_11
        )
        await TelemetryService.process_location_update(db, device_b, loc_b_11)

        # Verify User A's EntityState was not modified by User B's update
        db.expire_all()
        res = await db.execute(stmt)
        es_a = res.scalar_one()
        assert es_a.latitude == -38.3000

        # Verify User B's state is correct
        stmt_b = select(EntityState).where(EntityState.entity_id == "device_tracker.userb")
        res_b = await db.execute(stmt_b)
        es_b = res_b.scalar_one()
        assert es_b.latitude == -40.0000
        assert es_b.longitude == 140.0000

        # ---------------------------------------------------------
        # TEST 5: API REST ENDPOINT VERIFICATION
        # ---------------------------------------------------------
        # We query the members list endpoint as User A
        token_a = create_jwt_token({"sub": str(user_a.id)})
        response = client.get(
            f"/api/circles/{circle.id}/members",
            headers={"Authorization": f"Bearer {token_a}"}
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2

        # Verify that User A's returned device has the accepted coordinates (Point B alternate)
        mem_a = next(m for m in data if m["username"] == "usera")
        assert len(mem_a["devices"]) == 1
        assert mem_a["devices"][0]["latitude"] == -38.3000
        assert mem_a["devices"][0]["longitude"] == 145.3000
        assert mem_a["devices"][0]["last_updated"] == time_11.isoformat()
