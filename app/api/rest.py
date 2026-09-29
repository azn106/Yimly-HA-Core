from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.deps import require_authenticated_user
from app.core.config import settings
from app.core.logging import logger
from app.db.database import get_db
from app.db.models import User, LocationHistory, CircleMember, EntityState, Device
from app.schemas.api import ConfigResponse, EntityStateResponse, UnitSystem
from app.services.state_service import StateService
from app.services.event_service import event_bus
from app.services.telemetry_service import cleanup_history_for_user

router = APIRouter()

@router.get("/api/")
async def api_root(user: User = Depends(require_authenticated_user)):
    return {"message": "API running."}

@router.get("/api/config", response_model=ConfigResponse)
async def api_config(user: User = Depends(require_authenticated_user)) -> ConfigResponse:
    # Build dynamically generated config responses
    return ConfigResponse(
        components=["api", "websocket", "mobile_app", "device_tracker", "sensor", "binary_sensor"],
        config_dir="/config",
        elevation=0,
        latitude=0.0,
        location_name="Home Assistant Compatible Server",
        longitude=0.0,
        time_zone="UTC",
        unit_system=UnitSystem(
            length="km",
            mass="g",
            pressure="Pa",
            temperature="°C",
            volume="L"
        ),
        version="2026.9.1",
        whitelist_external_dirs=[]
    )

@router.get("/api/discovery_info")
async def api_discovery_info():
    """Home Assistant Core discovery_info endpoint for Companion App discovery and connection handshake."""
    return {
        "base_url": settings.BASE_URL,
        "location_name": "Home Assistant",
        "installation_type": "Home Assistant OS",
        "version": "2026.9.1",
        "requires_api_password": False
    }

@router.get("/api/services")
async def api_services(user: User = Depends(require_authenticated_user)):
    """Home Assistant Core services endpoint returning supported service domains."""
    return [
        {
            "domain": "homeassistant",
            "services": {
                "turn_on": {
                    "name": "Turn on",
                    "description": "Turn a device or entity on.",
                    "fields": {}
                },
                "turn_off": {
                    "name": "Turn off",
                    "description": "Turn a device or entity off.",
                    "fields": {}
                },
                "toggle": {
                    "name": "Toggle",
                    "description": "Toggle a device or entity state.",
                    "fields": {}
                },
                "update_entity": {
                    "name": "Update entity",
                    "description": "Request entity state update.",
                    "fields": {}
                }
            }
        },
        {
            "domain": "device_tracker",
            "services": {
                "see": {
                    "name": "See",
                    "description": "Manually record device location.",
                    "fields": {}
                }
            }
        },
        {
            "domain": "notify",
            "services": {
                "notify": {
                    "name": "Send notification",
                    "description": "Send a notification to a companion app device.",
                    "fields": {}
                }
            }
        }
    ]

@router.get("/api/states", response_model=List[EntityStateResponse])
async def api_get_states(
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
) -> List[EntityStateResponse]:
    entities = await StateService.get_all_states(db, user.id)
    return [
        EntityStateResponse(
            entity_id=e.entity_id,
            state=e.state,
            attributes=e.attributes,
            last_changed=e.last_changed.isoformat(),
            last_updated=e.last_updated.isoformat(),
            context={"id": f"ctx_{e.entity_id}", "user_id": str(user.id)}
        )
        for e in entities
    ]

@router.get("/api/states/{entity_id}", response_model=EntityStateResponse)
async def api_get_state(
    entity_id: str,
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
) -> EntityStateResponse:
    state_obj = await StateService.get_state(db, user.id, entity_id)
    if not state_obj:
        raise HTTPException(status_code=404, detail="Entity state not found.")
    return EntityStateResponse(
        entity_id=state_obj.entity_id,
        state=state_obj.state,
        attributes=state_obj.attributes,
        last_changed=state_obj.last_changed.isoformat(),
        last_updated=state_obj.last_updated.isoformat(),
        context={"id": f"ctx_{state_obj.entity_id}", "user_id": str(user.id)}
    )

@router.post("/api/states/{entity_id}", response_model=EntityStateResponse)
async def api_set_state(
    entity_id: str,
    payload: Dict[str, Any],
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
) -> EntityStateResponse:
    state_val = payload.get("state")
    if state_val is None:
        raise HTTPException(status_code=400, detail="The 'state' field is required in the body payload.")
    
    attributes = payload.get("attributes", {})
    
    entity = await StateService.set_state(
        db=db,
        user_id=user.id,
        entity_id=entity_id,
        state=str(state_val),
        attributes=attributes
    )
    
    return EntityStateResponse(
        entity_id=entity.entity_id,
        state=entity.state,
        attributes=entity.attributes,
        last_changed=entity.last_changed.isoformat(),
        last_updated=entity.last_updated.isoformat(),
        context={"id": f"ctx_{entity.entity_id}", "user_id": str(user.id)}
    )

@router.get("/api/components")
async def api_components(user: User = Depends(require_authenticated_user)):
    return ["api", "websocket", "mobile_app", "device_tracker", "sensor", "binary_sensor"]

@router.get("/api/services")
async def api_services(user: User = Depends(require_authenticated_user)):
    # Returns empty or basic capabilities to fulfill queries
    return [
        {
            "domain": "device_tracker",
            "services": {
                "see": {
                    "description": "Direct state updates",
                    "fields": {}
                }
            }
        }
    ]

@router.get("/api/events")
async def api_events(user: User = Depends(require_authenticated_user)):
    return [
        {
            "event": "state_changed",
            "listener_count": 0
        },
        {
            "event": "find_my",
            "listener_count": 1
        }
    ]

@router.post("/api/events/{event_type}")
@router.post("/api/events")
async def api_fire_event(
    event_type: Optional[str] = "find_my",
    payload: Optional[Dict[str, Any]] = None,
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    ev_type = event_type or (payload.get("event_type") if payload else "find_my")
    ev_data = payload or {}
    entity_id = ev_data.get("entity_id")
    
    if not entity_id:
        raise HTTPException(status_code=400, detail="Target device entity_id is required")
        
    stmt = select(EntityState).where(EntityState.entity_id == entity_id)
    res = await db.execute(stmt)
    target_entity = res.scalar_one_or_none()
    
    if not target_entity:
        raise HTTPException(status_code=404, detail="Target device entity_id not found")
        
    if target_entity.user_id != user.id:
        attrs = target_entity.attributes or {}
        if attrs.get("allow_find_my_device") is False:
            raise HTTPException(status_code=403, detail="Find My Device is disabled for this member's device")
            
    ev_data["triggered_by"] = user.username
    ev_data["device_name"] = (target_entity.attributes or {}).get("friendly_name") or entity_id
    
    event_obj = await event_bus.fire(ev_type, ev_data, user_id=target_entity.user_id)
    logger.info(f"Fired Home Assistant event '{ev_type}' for entity {entity_id}")
    return {
        "message": f"Event {ev_type} fired for device {ev_data['device_name']}.",
        "event": event_obj
    }

@router.get("/api/history/period")
@router.get("/api/history/period/{timestamp}")
async def api_get_history_period(
    timestamp: Optional[str] = None,
    user_id: Optional[int] = Query(None),
    filter_entity_id: Optional[str] = Query(None),
    hours: Optional[int] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    target_user_id = user_id if user_id is not None else user.id

    # Verify authorization: current user can view their own history or members in a shared circle
    if target_user_id != user.id:
        stmt_user_circles = select(CircleMember.circle_id).where(CircleMember.user_id == user.id)
        user_circle_ids = (await db.execute(stmt_user_circles)).scalars().all()

        stmt_shared = select(CircleMember).where(
            CircleMember.user_id == target_user_id,
            CircleMember.circle_id.in_(user_circle_ids)
        )
        has_shared = (await db.execute(stmt_shared)).scalar_one_or_none()
        if not has_shared:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not authorized to view this member's location history"
            )

    # Prune expired history for target user according to their retention setting
    stmt_target_user = select(User.history_retention).where(User.id == target_user_id)
    target_retention = (await db.execute(stmt_target_user)).scalar_one_or_none() or "30d"
    await cleanup_history_for_user(db, target_user_id, target_retention)

    stmt = select(LocationHistory).where(LocationHistory.user_id == target_user_id)
    if hours:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        stmt = stmt.where(LocationHistory.timestamp >= cutoff)
    else:
        if start_date:
            try:
                if "T" in start_date:
                    start_dt = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
                else:
                    start_dt = datetime.fromisoformat(f"{start_date}T00:00:00+00:00")
                stmt = stmt.where(LocationHistory.timestamp >= start_dt)
            except Exception:
                pass
        if end_date:
            try:
                if "T" in end_date:
                    end_dt = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
                else:
                    end_dt = datetime.fromisoformat(f"{end_date}T23:59:59.999999+00:00")
                stmt = stmt.where(LocationHistory.timestamp <= end_dt)
            except Exception:
                pass

    stmt = stmt.order_by(LocationHistory.timestamp.desc()).limit(200)
    res = await db.execute(stmt)
    records = res.scalars().all()

    if not records:
        # Fallback to current device_tracker states if no recorded history entries yet
        stmt_states = select(EntityState).where(
            EntityState.user_id == target_user_id,
            EntityState.domain == "device_tracker"
        )
        res_states = await db.execute(stmt_states)
        states = res_states.scalars().all()
        return [
            {
                "id": f"state_{st.entity_id}",
                "entity_id": st.entity_id,
                "user_id": st.user_id,
                "latitude": st.latitude,
                "longitude": st.longitude,
                "accuracy": st.attributes.get("gps_accuracy") if isinstance(st.attributes, dict) else None,
                "battery_level": st.attributes.get("battery_level") or st.attributes.get("battery") if isinstance(st.attributes, dict) else None,
                "timestamp": st.last_updated.isoformat() if hasattr(st.last_updated, "isoformat") else str(st.last_updated)
            }
            for st in states
            if st.latitude is not None and st.longitude is not None
        ]

    return [
        {
            "id": str(r.id),
            "entity_id": f"device_tracker.device_{r.device_id}",
            "user_id": r.user_id,
            "latitude": r.latitude,
            "longitude": r.longitude,
            "accuracy": r.accuracy,
            "altitude": r.altitude,
            "speed": r.speed,
            "bearing": r.bearing,
            "timestamp": r.timestamp.isoformat() if hasattr(r.timestamp, "isoformat") else str(r.timestamp)
        }
        for r in records
    ]


@router.get("/api/ha/devices")
@router.get("/api/devices/available")
async def api_get_ha_devices(
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    stmt = select(EntityState).where(
        EntityState.domain == "device_tracker"
    )
    res = await db.execute(stmt)
    entities = res.scalars().all()

    devices = []
    for st in entities:
        attrs = st.attributes if isinstance(st.attributes, dict) else {}
        devices.append({
            "entity_id": st.entity_id,
            "device_name": attrs.get("friendly_name") or st.entity_id,
            "state": st.state or "unknown",
            "is_available": True,
            "latitude": st.latitude,
            "longitude": st.longitude,
            "accuracy": attrs.get("gps_accuracy"),
            "battery": attrs.get("battery") or attrs.get("battery_level") or 100,
            "charging": attrs.get("charging"),
            "platform": attrs.get("source_type") or "mobile_app",
            "last_updated": st.last_updated.isoformat() if hasattr(st.last_updated, "isoformat") else str(st.last_updated) if st.last_updated else None,
            "map_icon": attrs.get("map_icon") or "📱 Phone"
        })
    devices.sort(key=lambda d: d["device_name"].lower())
    return devices


@router.get("/api/devices")
async def api_get_devices(
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    stmt = select(EntityState).where(
        EntityState.user_id == user.id,
        EntityState.domain == "device_tracker"
    )
    res = await db.execute(stmt)
    entities = res.scalars().all()

    devices_list = []
    has_explicit_default = any(
        isinstance(st.attributes, dict) and st.attributes.get("is_default")
        for st in entities
    )

    for index, st in enumerate(entities):
        attrs = st.attributes if isinstance(st.attributes, dict) else {}
        is_def = bool(attrs.get("is_default", False if has_explicit_default else index == 0))
        battery_val = attrs.get("battery")
        if battery_val is None:
            battery_val = attrs.get("battery_level")
        if battery_val is None:
            battery_val = 100

        devices_list.append({
            "entity_id": st.entity_id,
            "name": attrs.get("friendly_name") or st.entity_id,
            "platform": attrs.get("source_type") or "mobile_app",
            "battery": battery_val,
            "charging": attrs.get("charging"),
            "state": st.state,
            "last_updated": st.last_updated.isoformat() if hasattr(st.last_updated, "isoformat") else str(st.last_updated),
            "location_visibility": attrs.get("location_visibility", "family"),
            "map_icon": attrs.get("map_icon", "📱 Phone"),
            "is_default": is_def,
            "allow_find_my_device": attrs.get("allow_find_my_device", True)
        })

    return devices_list


@router.put("/api/devices/{entity_id:path}")
async def api_update_device(
    entity_id: str,
    payload: Dict[str, Any],
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    stmt = select(EntityState).where(
        EntityState.user_id == user.id,
        EntityState.entity_id == entity_id
    )
    res = await db.execute(stmt)
    st = res.scalar_one_or_none()
    if not st:
        raise HTTPException(status_code=404, detail="Device entity not found")

    attrs = dict(st.attributes) if isinstance(st.attributes, dict) else {}

    if "name" in payload:
        attrs["friendly_name"] = payload["name"]
    if "location_visibility" in payload:
        attrs["location_visibility"] = payload["location_visibility"]
    if "map_icon" in payload:
        attrs["map_icon"] = payload["map_icon"]
    if "allow_find_my_device" in payload:
        attrs["allow_find_my_device"] = payload["allow_find_my_device"]

    if "is_default" in payload and payload["is_default"] is True:
        # Clear default flag on all other device trackers for this user
        stmt_all = select(EntityState).where(
            EntityState.user_id == user.id,
            EntityState.domain == "device_tracker"
        )
        res_all = await db.execute(stmt_all)
        for other_st in res_all.scalars().all():
            other_attrs = dict(other_st.attributes) if isinstance(other_st.attributes, dict) else {}
            other_attrs["is_default"] = (other_st.entity_id == entity_id)
            other_st.attributes = other_attrs
            db.add(other_st)
        attrs["is_default"] = True

    st.attributes = attrs
    db.add(st)
    await db.commit()

    return {
        "entity_id": st.entity_id,
        "name": attrs.get("friendly_name") or st.entity_id,
        "platform": attrs.get("source_type") or "mobile_app",
        "battery": attrs.get("battery") or attrs.get("battery_level") or 100,
        "charging": attrs.get("charging"),
        "state": st.state,
        "last_updated": st.last_updated.isoformat() if hasattr(st.last_updated, "isoformat") else str(st.last_updated),
        "location_visibility": attrs.get("location_visibility", "family"),
        "map_icon": attrs.get("map_icon", "📱 Phone"),
        "is_default": attrs.get("is_default", False),
        "allow_find_my_device": attrs.get("allow_find_my_device", True)
    }


@router.delete("/api/devices/{entity_id:path}")
async def api_delete_device(
    entity_id: str,
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    stmt = select(EntityState).where(
        EntityState.user_id == user.id,
        EntityState.entity_id == entity_id
    )
    res = await db.execute(stmt)
    st = res.scalar_one_or_none()
    if not st:
        raise HTTPException(status_code=404, detail="Device entity not found")

    device_id = st.device_id
    await db.delete(st)

    if device_id:
        stmt_dev = select(Device).where(
            Device.id == device_id,
            Device.user_id == user.id
        )
        res_dev = await db.execute(stmt_dev)
        dev = res_dev.scalar_one_or_none()
        if dev:
            await db.delete(dev)

    await db.commit()

    return {"success": True, "message": "Device deleted successfully"}
