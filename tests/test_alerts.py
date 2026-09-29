import asyncio
import os
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from app.main import app
from app.db.database import Base, get_db
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService
from app.core.security import create_jwt_token
from app.services.alert_service import AlertService
from app.schemas.alerts import AlertCreate

TEST_DATABASE_URL = "sqlite+aiosqlite:////tmp/test_ha_alerts.db"
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

    for db_file in ["/tmp/test_ha_alerts.db", "/tmp/test_ha_alerts.db-shm", "/tmp/test_ha_alerts.db-wal"]:
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
async def test_alerts_full_validation_and_crud():
    async with db_session_test_maker() as db:
        # Create User 1
        u1 = await AuthService.create_user(db, UserCreate(username="alerts_u1", password="password123", display_name="User One"))
        token1 = create_jwt_token(u1.id, u1.username)
        headers1 = {"Authorization": f"Bearer {token1}"}

        # Create User 2
        u2 = await AuthService.create_user(db, UserCreate(username="alerts_u2", password="password123", display_name="User Two"))
        token2 = create_jwt_token(u2.id, u2.username)
        headers2 = {"Authorization": f"Bearer {token2}"}

        # User 1 creates Circle 1
        res_c1 = client.post("/api/circles", json={"name": "Circle One"}, headers=headers1)
        assert res_c1.status_code == 200
        c1_id = res_c1.json()["id"]

        # User 2 creates Circle 2
        res_c2 = client.post("/api/circles", json={"name": "Circle Two"}, headers=headers2)
        assert res_c2.status_code == 200
        c2_id = res_c2.json()["id"]

        # 1. Unauthenticated request is rejected
        res_unauth = client.get(f"/api/circles/{c1_id}/alerts")
        assert res_unauth.status_code == 401

        # 2. Non-member cannot access circle Alerts
        res_forbidden = client.get(f"/api/circles/{c1_id}/alerts", headers=headers2)
        assert res_forbidden.status_code == 403

        # 3. Authenticated member can list Alerts (starts empty)
        res_list_empty = client.get(f"/api/circles/{c1_id}/alerts", headers=headers1)
        assert res_list_empty.status_code == 200
        assert res_list_empty.json() == []

        # 4. Invalid alert_type rejection check using schema validator / direct service call
        with pytest.raises(ValueError) as exc_info:
            await AlertService.create_alert(db, AlertCreate(
                circle_id=c1_id,
                user_id=u1.id,
                target_user_id=u2.id,
                alert_type="invalid_type",  # Invalid type!
                title="Bad Alert",
                message="This should crash"
            ))
        assert "Invalid alert_type" in str(exc_info.value)

        # 5. Alert creation via service (as triggers aren't automatic yet)
        alert1 = await AlertService.create_alert(db, AlertCreate(
            circle_id=c1_id,
            user_id=u1.id,
            target_user_id=u2.id,
            alert_type="arrival",
            title="Arrived Home",
            message="User One arrived home safely."
        ))
        assert alert1.id is not None
        assert alert1.circle_id == c1_id
        assert alert1.user_id == u1.id
        assert alert1.alert_type == "arrival"
        assert alert1.read is False

        # Create a second older alert to check ordering
        # Add a tiny sleep to guarantee different timestamps if needed, or rely on serial creation
        await asyncio.sleep(0.1)

        alert2 = await AlertService.create_alert(db, AlertCreate(
            circle_id=c1_id,
            user_id=u1.id,
            alert_type="low_battery",
            title="Low Battery",
            message="User One has low battery (10%)."
        ))

        # 6. Retrieve authorized alerts newest-first
        res_list = client.get(f"/api/circles/{c1_id}/alerts", headers=headers1)
        assert res_list.status_code == 200
        alerts = res_list.json()
        assert len(alerts) == 2
        # newest first
        assert alerts[0]["id"] == alert2.id
        assert alerts[1]["id"] == alert1.id

        # 7. Alert remains isolated to the correct circle/user
        # User 2 list is empty (different user/circle)
        res_list_u2 = client.get(f"/api/circles/{c2_id}/alerts", headers=headers2)
        assert res_list_u2.status_code == 200
        assert res_list_u2.json() == []

        # 8. Cross-circle retrieval rejection is handled by check_circle_membership
        res_cross_circle = client.get(f"/api/circles/{c1_id}/alerts", headers=headers2)
        assert res_cross_circle.status_code == 403

        # 9. Mark own alert as read
        res_read = client.put(f"/api/circles/{c1_id}/alerts/{alert1.id}/read", headers=headers1)
        assert res_read.status_code == 200
        assert res_read.json()["read"] is True

        # Check list again to confirm it is read
        res_list_after = client.get(f"/api/circles/{c1_id}/alerts", headers=headers1)
        assert res_list_after.json()[1]["read"] is True

        # 10. Cross-user mark-as-read rejection
        # User 2 tries to read User 1's alert. User 2 must first join User 1's circle to pass check_circle_membership, or we can test direct cross-user isolation.
        # Let's join User 2 to User 1's circle first.
        invite_code = res_c1.json()["invite_code"]
        res_join = client.post("/api/circles/join", json={"invite_code": invite_code}, headers=headers2)
        assert res_join.status_code == 200

        # Now User 2 is in Circle 1, but the alert still belongs to User 1 (user_id=u1.id).
        # User 2 attempts to mark User 1's alert as read.
        res_cross_read = client.put(f"/api/circles/{c1_id}/alerts/{alert1.id}/read", headers=headers2)
        assert res_cross_read.status_code == 404
        assert "not found" in res_cross_read.json()["detail"].lower()


@pytest.mark.asyncio
async def test_alerts_circle_deletion_cascade():
    async with db_session_test_maker() as db:
        # Create User & Circle
        u = await AuthService.create_user(db, UserCreate(username="alerts_u3", password="password123", display_name="User Three"))
        token = create_jwt_token(u.id, u.username)
        headers = {"Authorization": f"Bearer {token}"}

        res_c = client.post("/api/circles", json={"name": "Temporary Circle"}, headers=headers)
        assert res_c.status_code == 200
        c_id = res_c.json()["id"]

        # Add alert
        alert = await AlertService.create_alert(db, AlertCreate(
            circle_id=c_id,
            user_id=u.id,
            alert_type="device_offline",
            title="Device Offline",
            message="Pixel phone went offline."
        ))
        assert alert.id is not None

        # Deleting circle removes its alerts automatically (CASCADE)
        res_del_circle = client.delete(f"/api/circles/{c_id}", headers=headers)
        assert res_del_circle.status_code == 200

        # Getting alerts for deleted circle returns 404
        res_get = client.get(f"/api/circles/{c_id}/alerts", headers=headers)
        assert res_get.status_code == 404
