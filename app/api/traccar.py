import math
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_authenticated_user
from app.core.logging import logger
from app.db.database import get_db
from app.db.models import Device, EntityState, User
from app.schemas.telemetry import LocationUpdateData
from app.services.telemetry_service import TelemetryService, slugify

router = APIRouter()


async def ensure_traccar_device_for_user(db: AsyncSession, user: User) -> Device:
    """Finds or auto-provisions a Traccar client device record for the user."""
    stmt = select(Device).where(
        Device.user_id == user.id,
        Device.app_id == "org.traccar.client"
    )
    res = await db.execute(stmt)
    device = res.scalar_one_or_none()

    if not device:
        token = secrets.token_urlsafe(32)
        device = Device(
            user_id=user.id,
            device_id=user.username,
            app_id="org.traccar.client",
            app_name="Traccar Client",
            app_version="10.0",
            device_name=f"{user.display_name or user.username}'s Phone",
            manufacturer="Traccar",
            model="Traccar Client",
            os_name="Mobile",
            os_version="10.0",
            supports_encryption=False,
            webhook_id=token,
            webhook_secret_hash="",
            created_at=datetime.now(timezone.utc),
            last_seen_at=datetime.now(timezone.utc),
            first_telemetry_received=False,
            low_battery_alert_triggered=False,
            device_offline_alert_triggered=False
        )
        db.add(device)
        await db.commit()
        await db.refresh(device)
        logger.info(f"Auto-provisioned Traccar device for user {user.username} (ID: {device.id})")
    elif device.device_id != user.username:
        device.device_id = user.username
        await db.commit()
        await db.refresh(device)

    return device


@router.get("/api/traccar/config")
async def get_traccar_config(
    request: Request,
    user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    device = await ensure_traccar_device_for_user(db, user)

    host = request.headers.get("host") or "127.0.0.1:3000"
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "http"
    server_url = f"{proto}://{host}/api/traccar/{device.webhook_id}"

    entity_name = slugify(user.username) or f"device_{device.id}"
    entity_id = f"device_tracker.{entity_name}"
    stmt_entity = select(EntityState).where(EntityState.entity_id == entity_id)
    res_entity = await db.execute(stmt_entity)
    entity = res_entity.scalar_one_or_none()

    battery_val = device.last_known_battery
    if battery_val is None and entity and isinstance(entity.attributes, dict):
        battery_val = entity.attributes.get("battery_level") or entity.attributes.get("battery")

    return {
        "device_id": user.username,
        "token": device.webhook_id,
        "server_url": server_url,
        "qr_uri": f"{server_url}?id={user.username}",
        "last_seen_at": device.last_seen_at.isoformat() if device.last_seen_at else None,
        "battery": battery_val,
        "latitude": entity.latitude if entity else None,
        "longitude": entity.longitude if entity else None,
        "first_telemetry_received": device.first_telemetry_received
    }


async def _handle_traccar_request(token: Optional[str], request: Request, db: AsyncSession):
    # Support token in path or query
    if not token:
        token = request.query_params.get("token")

    # Also check form body for token
    form_data = {}
    try:
        raw_form = await request.form()
        form_data = dict(raw_form)
    except Exception:
        pass

    if not token and "token" in form_data:
        token = str(form_data["token"])

    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing or invalid Traccar token")

    stmt = select(Device).where(Device.webhook_id == token)
    res = await db.execute(stmt)
    device = res.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid or revoked Traccar token")

    stmt_user = select(User).where(User.id == device.user_id)
    res_user = await db.execute(stmt_user)
    user = res_user.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found for this Traccar device")

    # Combine query parameters and form parameters
    params: Dict[str, Any] = {}
    params.update(dict(request.query_params))
    params.update(form_data)

    # Validate Traccar Device ID corresponds to user's username
    raw_id = params.get("id") or params.get("deviceid")
    if raw_id:
        raw_id_str = str(raw_id).strip()
        if raw_id_str and raw_id_str.lower() != user.username.lower():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Traccar Device ID '{raw_id_str}' does not match expected username '{user.username}'"
            )

    # Coordinate validation
    raw_lat = params.get("lat")
    raw_lon = params.get("lon")
    has_lat = raw_lat is not None and str(raw_lat).strip() != ""
    has_lon = raw_lon is not None and str(raw_lon).strip() != ""

    lat: Optional[float] = None
    lon: Optional[float] = None

    if has_lat or has_lon:
        if not has_lat or not has_lon:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Both latitude and longitude must be provided")
        try:
            lat = float(str(raw_lat))
            lon = float(str(raw_lon))
        except (ValueError, TypeError):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid coordinate number format")

        if not (-90.0 <= lat <= 90.0):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid latitude: must be between -90 and 90")
        if not (-180.0 <= lon <= 180.0):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid longitude: must be between -180 and 180")

    # Speed conversion: Traccar sends speed in KNOTS! Convert to metres/second (1 knot = 0.514444 m/s)
    speed_mps: Optional[float] = None
    raw_speed = params.get("speed")
    if raw_speed is not None and str(raw_speed).strip() != "":
        try:
            speed_knots = float(str(raw_speed))
            speed_mps = round(speed_knots * 0.514444, 2)
        except (ValueError, TypeError):
            pass

    # Timestamp conversion: Unix epoch in seconds to UTC datetime
    raw_ts = params.get("timestamp")
    fix_dt = datetime.now(timezone.utc)
    if raw_ts is not None and str(raw_ts).strip() != "":
        try:
            ts_num = float(str(raw_ts))
            if ts_num > 10000000000:
                ts_num /= 1000.0
            fix_dt = datetime.fromtimestamp(ts_num, tz=timezone.utc)
        except Exception:
            pass

    # Accuracy
    accuracy: Optional[float] = None
    raw_acc = params.get("accuracy")
    if raw_acc is not None and str(raw_acc).strip() != "":
        try:
            accuracy = float(str(raw_acc))
        except (ValueError, TypeError):
            pass

    # Altitude
    altitude: Optional[float] = None
    raw_alt = params.get("altitude")
    if raw_alt is not None and str(raw_alt).strip() != "":
        try:
            altitude = float(str(raw_alt))
        except (ValueError, TypeError):
            pass

    # Bearing / Course
    bearing: Optional[float] = None
    raw_bearing = params.get("bearing") or params.get("heading")
    if raw_bearing is not None and str(raw_bearing).strip() != "":
        try:
            bearing = float(str(raw_bearing))
        except (ValueError, TypeError):
            pass

    # Battery
    battery: Optional[float] = None
    raw_batt = params.get("batt") or params.get("battery")
    if raw_batt is not None and str(raw_batt).strip() != "":
        try:
            battery = max(0.0, min(100.0, float(str(raw_batt))))
        except (ValueError, TypeError):
            pass

    # Charging
    charging: Optional[bool] = None
    raw_charge = params.get("charge") or params.get("charging")
    if raw_charge is not None:
        charging = str(raw_charge).lower().strip() in ("true", "1")

    # Alarm
    alarm = str(params.get("alarm")).strip() if params.get("alarm") else None

    # Construct LocationUpdateData
    loc_data = LocationUpdateData(
        latitude=lat,
        longitude=lon,
        gps_accuracy=accuracy,
        altitude=altitude,
        speed=speed_mps,
        bearing=bearing,
        battery=battery,
        trigger=alarm or "traccar"
    )

    # Process location update through existing pipeline
    entity_name = slugify(user.username) or f"device_{device.id}"
    entity_id = f"device_tracker.{entity_name}"
    stmt_existing = select(EntityState).where(EntityState.entity_id == entity_id)
    res_existing = await db.execute(stmt_existing)
    existing_entity = res_existing.scalar_one_or_none()

    existing_time = existing_entity.last_updated if (existing_entity and existing_entity.last_updated) else datetime.min.replace(tzinfo=timezone.utc)
    is_newer_fix = fix_dt >= existing_time

    if lat is not None and lon is not None:
        # Use TelemetryService
        await TelemetryService.process_location_update(db, device, loc_data)
        # Ensure timestamp reflects Traccar fix timestamp if newer
        if existing_entity and is_newer_fix:
            existing_entity.last_updated = fix_dt
            await db.commit()
    else:
        # Heartbeat without coordinates: update last_seen_at without destroying last valid coords
        now = datetime.now(timezone.utc)
        device.last_seen_at = now
        device.first_telemetry_received = True
        device.device_offline_alert_triggered = False
        if battery is not None:
            device.last_known_battery = battery
        if existing_entity and isinstance(existing_entity.attributes, dict):
            if battery is not None:
                existing_entity.attributes["battery_level"] = battery
                existing_entity.attributes["battery"] = battery
            if charging is not None:
                existing_entity.attributes["charging"] = charging
        await db.commit()

    return JSONResponse(
        content={
            "success": True,
            "message": "Traccar telemetry processed successfully",
            "diagnostics": {
                "userId": user.id,
                "entityId": entity_id,
                "lat": lat if (lat is not None and is_newer_fix) else (existing_entity.latitude if existing_entity else None),
                "lon": lon if (lon is not None and is_newer_fix) else (existing_entity.longitude if existing_entity else None),
                "speedMps": speed_mps,
                "battery": battery,
                "timestamp": fix_dt.isoformat()
            }
        },
        status_code=status.HTTP_200_OK
    )


@router.post("/api/traccar/{token}")
@router.post("/api/traccar")
async def post_traccar_location(
    request: Request,
    token: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    return await _handle_traccar_request(token, request, db)


@router.get("/api/traccar/{token}")
@router.get("/api/traccar")
async def get_traccar_location(
    request: Request,
    token: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    return await _handle_traccar_request(token, request, db)
