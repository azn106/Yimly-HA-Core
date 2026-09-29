from datetime import datetime, timezone
from typing import Any, Dict, List
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.logging import logger
from app.db.database import get_db
from app.db.models import CircleMember, Place
from app.schemas.telemetry import LocationUpdateData, SensorRegistrationData, SensorStateUpdate
from app.services.encryption_service import EncryptionService
from app.services.mobile_app_service import MobileAppService
from app.services.telemetry_service import TelemetryService, slugify

router = APIRouter()

@router.post("/api/webhook/{webhook_id}")
async def handle_webhook(
    webhook_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    device = await MobileAppService.get_device_by_webhook(db, webhook_id)
    if not device:
        # HTTP 410 Gone is critical: it signals to the Companion App that this registration
        # was revoked or superseded, which prompts re-pairing.
        logger.warning(f"Unrecognized or superseded webhook_id {webhook_id}. Returning HTTP 410.")
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Webhook deleted or not found.")

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Request body is not valid JSON.")

    if not isinstance(payload, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payload must be a JSON object.")

    # Handle Encrypted Webhook Payloads
    # The official Home Assistant Companion App sends encrypted webhooks as:
    # {"type": "encrypted", "encrypted": true, "encrypted_data": "<base64_ciphertext>"}
    # or {"type": "encrypted", "data": "<base64_ciphertext>"} or {"encrypted": true, "encrypted_data": "..."}
    is_encrypted = (
        payload.get("type") == "encrypted"
        or payload.get("encrypted") is True
        or ("encrypted_data" in payload and "type" not in payload)
    )

    if is_encrypted:
        encrypted_b64 = payload.get("encrypted_data") or payload.get("data")
        if not encrypted_b64 or not isinstance(encrypted_b64, str):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Encrypted webhook payload missing 'encrypted_data' field."
            )
        if not device.webhook_secret:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Encryption is not negotiated or configured for this device registration."
            )
        try:
            decrypted_payload = EncryptionService.decrypt(device.webhook_secret, encrypted_b64)
            if not isinstance(decrypted_payload, dict):
                raise ValueError("Decrypted payload is not a JSON dictionary.")
            payload = decrypted_payload
        except ValueError as err:
            logger.warning(f"Failed to decrypt encrypted webhook for device {device.id}: {err}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Decryption failed: {err}"
            )

    req_type = payload.get("type")
    if not req_type:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payload must contain 'type' field.")

    req_data = payload.get("data")

    # 1. enable_encryption command
    if req_type == "enable_encryption":
        new_secret = EncryptionService.generate_secret()
        device.supports_encryption = True
        device.webhook_secret = new_secret
        device.webhook_secret_hash = MobileAppService.hash_value(new_secret)
        await db.commit()
        await db.refresh(device)
        logger.info(f"Enabled encryption on webhook for device {device.id}")
        return JSONResponse(content={"secret": new_secret}, status_code=status.HTTP_200_OK)

    # 2. get_zones command (does not require 'data')
    elif req_type == "get_zones":
        zones = []
        if device.user_id:
            stmt_circles = select(CircleMember.circle_id).where(CircleMember.user_id == device.user_id)
            res_circles = await db.execute(stmt_circles)
            circle_ids = res_circles.scalars().all()
            if circle_ids:
                stmt_places = select(Place).where(Place.circle_id.in_(circle_ids))
                res_places = await db.execute(stmt_places)
                places = res_places.scalars().all()
                for p in places:
                    zone_slug = slugify(p.name) or f"place_{p.id}"
                    zones.append({
                        "entity_id": f"zone.{zone_slug}",
                        "state": "zoning",
                        "attributes": {
                            "latitude": p.latitude,
                            "longitude": p.longitude,
                            "radius": p.radius,
                            "friendly_name": p.name,
                            "icon": "mdi:map-marker"
                        }
                    })
        return JSONResponse(content=zones, status_code=status.HTTP_200_OK)

    # 3. get_config command (does not require 'data')
    elif req_type == "get_config":
        config_resp = {
            "latitude": 0.0,
            "longitude": 0.0,
            "elevation": 0,
            "unit_system": {
                "length": "km",
                "mass": "g",
                "temperature": "\u00b0C",
                "volume": "L"
            },
            "location_name": "Home Assistant",
            "time_zone": "UTC",
            "components": ["api", "websocket", "mobile_app", "webhook", "zone", "device_tracker", "sensor", "binary_sensor"],
            "version": "2026.9.1",
            "theme_color": "#03a9f4",
            "entities": {}
        }
        return JSONResponse(content=config_resp, status_code=status.HTTP_200_OK)

    # 4. update_registration command
    elif req_type == "update_registration":
        if isinstance(req_data, dict):
            if "app_version" in req_data and req_data["app_version"]:
                device.app_version = str(req_data["app_version"])
            if "device_name" in req_data and req_data["device_name"]:
                device.device_name = str(req_data["device_name"])
            if "manufacturer" in req_data and req_data["manufacturer"]:
                device.manufacturer = str(req_data["manufacturer"])
            if "model" in req_data and req_data["model"]:
                device.model = str(req_data["model"])
            if "os_version" in req_data and req_data["os_version"]:
                device.os_version = str(req_data["os_version"])
            if "app_data" in req_data and isinstance(req_data["app_data"], dict):
                device.app_data = req_data["app_data"]
            await db.commit()
            await db.refresh(device)
            return JSONResponse(
                content={
                    "app_version": device.app_version,
                    "device_name": device.device_name,
                    "manufacturer": device.manufacturer,
                    "model": device.model,
                    "os_version": device.os_version,
                    "app_data": device.app_data or {}
                },
                status_code=status.HTTP_200_OK
            )
        return JSONResponse(content={}, status_code=status.HTTP_200_OK)

    # 5. update_location command
    elif req_type == "update_location":
        if req_data is None:
            # HA Core accepts empty update_location requests as a keepalive / ping
            now = datetime.now(timezone.utc)
            device.last_seen_at = now
            await db.commit()
            return JSONResponse(content={}, status_code=status.HTTP_200_OK)

        # Handle list/dict flexibility
        if isinstance(req_data, list):
            if not req_data:
                return JSONResponse(content={}, status_code=status.HTTP_200_OK)
            req_data = req_data[0]

        if not isinstance(req_data, dict):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="update_location data must be a JSON object.")

        try:
            loc_data = LocationUpdateData(**req_data)
            if loc_data.latitude is not None and loc_data.longitude is not None:
                await TelemetryService.process_location_update(db, device, loc_data)
            else:
                # Update device last_seen_at even if coordinates not provided (e.g. zone ping)
                now = datetime.now(timezone.utc)
                device.last_seen_at = now
                device.first_telemetry_received = True
                device.device_offline_alert_triggered = False
                await db.commit()
            return JSONResponse(content={}, status_code=status.HTTP_200_OK)
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Failed to process location update webhook: {e}")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Location payload validation error: {e}")

    # 6. register_sensor command
    elif req_type == "register_sensor":
        if req_data is None or not isinstance(req_data, dict):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing or invalid data for register_sensor.")

        try:
            sensor_data = SensorRegistrationData(**req_data)
            await TelemetryService.process_sensor_registration(db, device, sensor_data)
            now = datetime.now(timezone.utc)
            device.last_seen_at = now
            device.first_telemetry_received = True
            device.device_offline_alert_triggered = False
            await db.commit()
            return JSONResponse(content={"success": True}, status_code=status.HTTP_201_CREATED)
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Failed to process sensor registration: {e}")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Sensor registration validation error: {e}")

    # 7. update_sensor_states command
    elif req_type == "update_sensor_states":
        if req_data is None:
            return JSONResponse(content={}, status_code=status.HTTP_200_OK)

        try:
            if isinstance(req_data, dict):
                req_data = [req_data]
            elif not isinstance(req_data, list):
                raise ValueError("update_sensor_states data field must be an array.")

            updates = [SensorStateUpdate(**item) for item in req_data]
            res = await TelemetryService.process_sensor_state_updates(db, device, updates)
            now = datetime.now(timezone.utc)
            device.last_seen_at = now
            device.first_telemetry_received = True
            device.device_offline_alert_triggered = False
            await db.commit()
            return JSONResponse(content=res, status_code=status.HTTP_200_OK)
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Failed to process sensor updates: {e}")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Sensor states update error: {e}")

    # 8. Other commands (call_service, fire_event, scan_tag, render_template, stream_camera)
    elif req_type in ("call_service", "fire_event", "scan_tag", "render_template", "stream_camera"):
        return JSONResponse(content={}, status_code=status.HTTP_200_OK)

    # 9. Unhandled commands
    else:
        logger.warning(f"Received unhandled webhook command type: {req_type}")
        return JSONResponse(content={}, status_code=status.HTTP_200_OK)
