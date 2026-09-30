import asyncio
import os
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from app.main import app as fastapi_app
from app.db.database import Base, get_db

TEST_DATABASE_URL = "sqlite+aiosqlite:////tmp/test_ha_device_assign.db"
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

@pytest.fixture(autouse=True, scope="function")
def setup_test_db():
    import app.db.database
    import app.api.websocket
    orig_session_maker = app.db.database.async_session_maker
    orig_ws_session_maker = getattr(app.api.websocket, "async_session_maker", None)

    app.db.database.async_session_maker = db_session_test_maker
    app.api.websocket.async_session_maker = db_session_test_maker
    fastapi_app.dependency_overrides[get_db] = override_get_db

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def create_tables():
        async with test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        async with db_session_test_maker() as session:
            from app.services.auth_service import AuthService
            from app.schemas.auth import UserCreate
            await AuthService.create_user(session, UserCreate(username="setup_admin_base", password="AdminPassword123!", display_name="Setup Admin"))

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

@pytest.mark.asyncio
async def test_ha_device_discovery_and_member_assignment():
    transport = ASGITransport(app=fastapi_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. Register User
        user_reg = await ac.post("/api/auth/register", json={
            "username": f"ha_test_user_{int(asyncio.get_event_loop().time() * 1000)}",
            "password": "TestPassword123!",
            "display_name": "Test HA User"
        })
        assert user_reg.status_code == 200
        token = user_reg.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        # 2. Create Circle
        circle_res = await ac.post("/api/circles", headers=headers, json={"name": "Test Family Circle"})
        assert circle_res.status_code == 200
        circle_id = circle_res.json()["id"]

        # 3. Discovered HA Devices Endpoint
        devs_res = await ac.get("/api/circles/ha/devices", headers=headers)
        assert devs_res.status_code == 200
        assert isinstance(devs_res.json(), list)

        # 4. Create Yimly Member (Unassigned)
        member_res = await ac.post(f"/api/circles/{circle_id}/members", headers=headers, json={
            "display_name": "Robin Test",
            "avatar_color": "#FF9AA2",
            "assigned_entity_id": None
        })
        assert member_res.status_code == 200
        member_data = member_res.json()
        assert member_data["display_name"] == "Robin Test"
        assert member_data["avatar_color"] == "#FF9AA2"
        assert len(member_data["devices"]) == 0  # No fake coordinates

        member_id = member_data["id"]

        # 5. Assign HA Device to Member
        assign_res = await ac.put(f"/api/circles/{circle_id}/members/{member_id}", headers=headers, json={
            "display_name": "Robin Test",
            "assigned_entity_id": "device_tracker.robin_iphone"
        })
        assert assign_res.status_code == 200
        assert assign_res.json()["assigned_entity_id"] == "device_tracker.robin_iphone"

        # 6. List Members
        list_res = await ac.get(f"/api/circles/{circle_id}/members", headers=headers)
        assert list_res.status_code == 200
        members = list_res.json()
        robin = next((m for m in members if m["id"] == member_id), None)
        assert robin is not None
        assert robin["display_name"] == "Robin Test"
        assert robin["assigned_entity_id"] == "device_tracker.robin_iphone"

        # 7. Unassign Device
        unassign_res = await ac.put(f"/api/circles/{circle_id}/members/{member_id}", headers=headers, json={
            "assigned_entity_id": None
        })
        assert unassign_res.status_code == 200
        assert unassign_res.json()["assigned_entity_id"] is None
        assert len(unassign_res.json()["devices"]) == 0

        # 8. Delete Member
        del_res = await ac.delete(f"/api/circles/{circle_id}/members/{member_id}", headers=headers)
        assert del_res.status_code == 200

        # 9. Verify Security: LLAT not exposed in any response
        me_res = await ac.get("/api/auth/me", headers=headers)
        assert "HA_LONG_LIVED_ACCESS_TOKEN" not in me_res.text
        assert "eyJhbGciOi" not in me_res.text
