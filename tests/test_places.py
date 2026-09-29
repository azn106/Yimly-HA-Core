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

TEST_DATABASE_URL = "sqlite+aiosqlite:////tmp/test_ha_places.db"
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

    for db_file in ["/tmp/test_ha_places.db", "/tmp/test_ha_places.db-shm", "/tmp/test_ha_places.db-wal"]:
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
async def test_places_full_crud_and_validation():
    async with db_session_test_maker() as db:
        # Create User 1 & Circle 1
        u1 = await AuthService.create_user(db, UserCreate(username="places_u1", password="password123", display_name="User One"))
        token1 = create_jwt_token(u1.id, u1.username)
        headers1 = {"Authorization": f"Bearer {token1}"}

        # Create User 2 & Circle 2
        u2 = await AuthService.create_user(db, UserCreate(username="places_u2", password="password123", display_name="User Two"))
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
        res_unauth = client.get(f"/api/circles/{c1_id}/places")
        assert res_unauth.status_code == 401

        # 2. Non-member cannot access circle Places
        res_forbidden = client.get(f"/api/circles/{c1_id}/places", headers=headers2)
        assert res_forbidden.status_code == 403

        # 3. Authenticated member can list Places (starts empty)
        res_list_empty = client.get(f"/api/circles/{c1_id}/places", headers=headers1)
        assert res_list_empty.status_code == 200
        assert res_list_empty.json() == []

        # 4. Invalid latitude rejected
        res_bad_lat = client.post(f"/api/circles/{c1_id}/places", json={
            "name": "Invalid Lat Place",
            "latitude": 95.0,
            "longitude": -122.4194,
            "radius": 100
        }, headers=headers1)
        assert res_bad_lat.status_code == 422

        # 5. Invalid longitude rejected
        res_bad_lng = client.post(f"/api/circles/{c1_id}/places", json={
            "name": "Invalid Lng Place",
            "latitude": 37.7749,
            "longitude": -190.0,
            "radius": 100
        }, headers=headers1)
        assert res_bad_lng.status_code == 422

        # 6. Invalid radius rejected
        res_bad_rad = client.post(f"/api/circles/{c1_id}/places", json={
            "name": "Invalid Radius Place",
            "latitude": 37.7749,
            "longitude": -122.4194,
            "radius": -10
        }, headers=headers1)
        assert res_bad_rad.status_code == 422

        # 7. Authenticated member can create a Place
        place_data = {
            "name": "Home Base",
            "address": "123 Main St",
            "latitude": 37.7749,
            "longitude": -122.4194,
            "radius": 150.0,
            "icon": "home"
        }
        res_create = client.post(f"/api/circles/{c1_id}/places", json=place_data, headers=headers1)
        assert res_create.status_code == 201
        p1 = res_create.json()
        assert p1["name"] == "Home Base"
        assert p1["circle_id"] == c1_id
        assert p1["latitude"] == 37.7749
        assert p1["longitude"] == -122.4194
        assert p1["radius"] == 150.0
        p1_id = p1["id"]

        # 8. Authenticated member can list Places
        res_list = client.get(f"/api/circles/{c1_id}/places", headers=headers1)
        assert res_list.status_code == 200
        places = res_list.json()
        assert len(places) == 1
        assert places[0]["id"] == p1_id

        # 9. Authenticated member can retrieve a Place
        res_get = client.get(f"/api/circles/{c1_id}/places/{p1_id}", headers=headers1)
        assert res_get.status_code == 200
        assert res_get.json()["name"] == "Home Base"

        # 10. Place from another circle cannot be accessed by non-member
        res_cross_get = client.get(f"/api/circles/{c1_id}/places/{p1_id}", headers=headers2)
        assert res_cross_get.status_code == 403

        # 11. User 2 cannot access place p1 via their own circle c2 endpoint
        res_cross_c2 = client.get(f"/api/circles/{c2_id}/places/{p1_id}", headers=headers2)
        assert res_cross_c2.status_code == 404

        # 12. Authenticated member can update a Place
        res_update = client.put(f"/api/circles/{c1_id}/places/{p1_id}", json={
            "name": "Updated Home Base",
            "radius": 200.0
        }, headers=headers1)
        assert res_update.status_code == 200
        updated = res_update.json()
        assert updated["name"] == "Updated Home Base"
        assert updated["radius"] == 200.0

        # 13. Authenticated member can delete a Place
        res_del = client.delete(f"/api/circles/{c1_id}/places/{p1_id}", headers=headers1)
        assert res_del.status_code == 200

        # Confirm deleted
        res_get_deleted = client.get(f"/api/circles/{c1_id}/places/{p1_id}", headers=headers1)
        assert res_get_deleted.status_code == 404


@pytest.mark.asyncio
async def test_places_persistence_and_circle_deletion():
    async with db_session_test_maker() as db:
        # Create User & Circle
        u = await AuthService.create_user(db, UserCreate(username="places_u3", password="password123", display_name="User Three"))
        token = create_jwt_token(u.id, u.username)
        headers = {"Authorization": f"Bearer {token}"}

        res_c = client.post("/api/circles", json={"name": "Temporary Circle"}, headers=headers)
        assert res_c.status_code == 200
        c_id = res_c.json()["id"]

        # Add place
        res_create = client.post(f"/api/circles/{c_id}/places", json={
            "name": "Work Zone",
            "latitude": 37.7833,
            "longitude": -122.4167,
            "radius": 300.0
        }, headers=headers)
        assert res_create.status_code == 201
        p_id = res_create.json()["id"]

        # Deleting circle removes its places automatically (CASCADE)
        res_del_circle = client.delete(f"/api/circles/{c_id}", headers=headers)
        assert res_del_circle.status_code == 200

        # Getting places for deleted circle returns 404
        res_get = client.get(f"/api/circles/{c_id}/places", headers=headers)
        assert res_get.status_code == 404
