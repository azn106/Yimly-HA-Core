import asyncio
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_ha_device_discovery_and_member_assignment():
    transport = ASGITransport(app=app)
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
