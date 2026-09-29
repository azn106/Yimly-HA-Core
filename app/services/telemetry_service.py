import math
import re
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Device, LocationHistory, SensorRegistration, User
from app.schemas.telemetry import LocationUpdateData, SensorRegistrationData, SensorStateUpdate
from app.services.state_service import StateService

def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r'[^a-z0-9_]', '_', text)
    text = re.sub(r'_+', '_', text)
    return text.strip('_')

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    # Radius of Earth in meters
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0) ** 2 + \
        math.cos(phi1) * math.cos(phi2) * \
        math.sin(delta_lambda / 2.0) ** 2
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c

def get_retention_cutoff(retention: Optional[str]) -> Optional[datetime]:
    if not retention or retention == "forever":
        return None
    days_map = {
        "7d": 7,
        "30d": 30,
        "90d": 90,
        "1y": 365,
    }
    days = days_map.get(retention)
    if days is None:
        return None
    return datetime.now(timezone.utc) - timedelta(days=days)

async def cleanup_history_for_user(
    db: AsyncSession,
    user_id: int,
    retention: Optional[str] = None
) -> int:
    """
    Purges LocationHistory records for user_id older than the retention cutoff.
    Returns the number of deleted records.
    """
    if not retention or retention == "forever":
        return 0
    cutoff = get_retention_cutoff(retention)
    if cutoff is None:
        return 0
    stmt = delete(LocationHistory).where(
        LocationHistory.user_id == user_id,
        LocationHistory.timestamp < cutoff
    )
    result = await db.execute(stmt)
    await db.commit()
    return getattr(result, "rowcount", 0)

class TelemetryService:
    @staticmethod
    async def process_location_update(
        db: AsyncSession,
        device: Device,
        data: LocationUpdateData
    ) -> Dict[str, Any]:
        # Validate coordinates (redundant sanity check, Pydantic handles this but good to have)
        if not (-90.0 <= data.latitude <= 90.0) or not (-180.0 <= data.longitude <= 180.0):
            raise ValueError("Coordinates are out of bounds")

        now = datetime.now(timezone.utc)

        # 1. Log Location History (if enabled for user)
        should_save_history = True
        user_retention = "30d"
        if device.user_id:
            stmt_user = select(User.save_location_history, User.history_retention).where(User.id == device.user_id)
            res_user = await db.execute(stmt_user)
            row = res_user.first()
            if row:
                if row[0] is False:
                    should_save_history = False
                if row[1]:
                    user_retention = row[1]

        if should_save_history:
            loc_history = LocationHistory(
                device_id=device.id,
                user_id=device.user_id,
                latitude=data.latitude,
                longitude=data.longitude,
                accuracy=data.gps_accuracy,
                altitude=data.altitude,
                speed=data.speed,
                bearing=data.bearing,
                timestamp=now,
                trigger=data.trigger
            )
            db.add(loc_history)
            await db.commit()

        # Prune old location history according to user's history_retention
        if device.user_id:
            await cleanup_history_for_user(db, device.user_id, user_retention)

        # 2. Update Device Tracker Entity State
        entity_name = slugify(device.device_name)
        if not entity_name:
            entity_name = f"device_{device.id}"
        entity_id = f"device_tracker.{entity_name}"

        # Update last_known_battery if battery is provided in location update
        if data.battery is not None:
            try:
                battery_val = float(data.battery)
                if 0.0 <= battery_val <= 100.0:
                    device.last_known_battery = battery_val
                    await db.commit()
                    # Trigger potential alerts
                    try:
                        await TelemetryService._evaluate_low_battery(db, device, data)
                    except Exception as low_batt_err:
                        import logging
                        logging.getLogger("ha_server").error(f"Error evaluating low battery from location update: {low_batt_err}")
            except (ValueError, TypeError):
                pass

        # Determine if "home" or "not_home" (near the configured latitude/longitude from config)
        # We can read home lat/lon from a configuration. Let's default to server 0,0 or check if it's within 100 meters
        # In a real environment, the server is set to a specific location.
        distance_to_home = haversine_distance(data.latitude, data.longitude, 0.0, 0.0)
        state_val = "home" if distance_to_home <= 150.0 else "not_home"

        # Fetch existing state attributes to avoid wiping them out (e.g. charging/battery state)
        existing_state = await StateService.get_state(db, device.user_id, entity_id)
        existing_attrs = existing_state.attributes if (existing_state and isinstance(existing_state.attributes, dict)) else {}

        # Fallback to device's last known battery if not in payload
        effective_battery = data.battery if data.battery is not None else device.last_known_battery
        if effective_battery is None:
            effective_battery = existing_attrs.get("battery") or existing_attrs.get("battery_level")

        # Build state attributes, starting with existing ones to preserve custom metadata/charging state
        attributes = dict(existing_attrs)
        attributes.update({
            "latitude": data.latitude,
            "longitude": data.longitude,
            "gps_accuracy": data.gps_accuracy,
            "altitude": data.altitude,
            "speed": data.speed,
            "course": data.bearing,
            "friendly_name": device.device_name,
            "source_type": "gps"
        })

        if effective_battery is not None:
            attributes["battery_level"] = effective_battery
            attributes["battery"] = effective_battery

        # Filter out None values
        attributes = {k: v for k, v in attributes.items() if v is not None}

        await StateService.set_state(
            db=db,
            user_id=device.user_id,
            entity_id=entity_id,
            state=state_val,
            attributes=attributes,
            device_id=device.id,
            latitude=data.latitude,
            longitude=data.longitude
        )

        # Update last_seen_at for the device
        device.last_seen_at = now
        device.first_telemetry_received = True
        device.device_offline_alert_triggered = False
        await db.commit()

        # Run geofence evaluation
        try:
            await TelemetryService._evaluate_geofencing(db, device, data)
        except Exception as e:
            import logging
            logging.getLogger(__name__).exception(f"Error in geofencing evaluator: {e}")

        # Run low battery evaluation
        try:
            await TelemetryService._evaluate_low_battery(db, device, data)
        except Exception as e:
            import logging
            logging.getLogger(__name__).exception(f"Error in low-battery evaluator: {e}")

        return {"status": "ok"}

    @staticmethod
    async def _evaluate_geofencing(
        db: AsyncSession,
        device: Device,
        data: LocationUpdateData
    ) -> None:
        if not device.user_id:
            return

        from app.db.models import CircleMember, Place, GeofenceState, User
        from app.schemas.alerts import AlertCreate
        from app.services.alert_service import AlertService

        # 1. Fetch all circles where the device owner is a member
        stmt_circles = select(CircleMember.circle_id).where(CircleMember.user_id == device.user_id)
        res_circles = await db.execute(stmt_circles)
        circle_ids = res_circles.scalars().all()
        if not circle_ids:
            return

        # 2. Fetch all Places belonging to those circles
        stmt_places = select(Place).where(Place.circle_id.in_(circle_ids))
        res_places = await db.execute(stmt_places)
        places = res_places.scalars().all()
        if not places:
            return

        # 3. Process each Place
        for place in places:
            distance = haversine_distance(data.latitude, data.longitude, place.latitude, place.longitude)
            is_inside_now = distance <= place.radius

            # Determine user-level inside/outside before this update
            stmt_user_inside = select(GeofenceState.device_id).where(
                GeofenceState.user_id == device.user_id,
                GeofenceState.place_id == place.id,
                GeofenceState.inside == True
            )
            res_user_inside = await db.execute(stmt_user_inside)
            inside_device_ids = set(res_user_inside.scalars().all())
            was_user_inside_any = len(inside_device_ids) > 0

            # Get or create GeofenceState for this specific (user_id, device_id, place_id)
            stmt_state = select(GeofenceState).where(
                GeofenceState.user_id == device.user_id,
                GeofenceState.device_id == device.id,
                GeofenceState.place_id == place.id
            )
            res_state = await db.execute(stmt_state)
            gstate = res_state.scalar_one_or_none()

            if gstate is None:
                # Initial state registration for this device. Do not trigger alerts!
                gstate = GeofenceState(
                    user_id=device.user_id,
                    device_id=device.id,
                    place_id=place.id,
                    inside=is_inside_now
                )
                db.add(gstate)
                await db.commit()
                continue

            # Check transition with hysteresis
            was_device_inside = gstate.inside
            is_device_inside_now = was_device_inside

            if not was_device_inside:
                if distance <= place.radius:
                    is_device_inside_now = True
            else:
                # 20m hysteresis buffer to prevent rapid boundary jitter flapping
                if distance > (place.radius + 20.0):
                    is_device_inside_now = False

            if is_device_inside_now != was_device_inside:
                gstate.inside = is_device_inside_now
                await db.commit()
                await db.refresh(gstate)

                # Evaluate user-level transition
                if is_device_inside_now:
                    is_user_inside_any_now = True
                else:
                    other_devices_inside = inside_device_ids - {device.id}
                    is_user_inside_any_now = len(other_devices_inside) > 0

                is_arrival = (not was_user_inside_any and is_user_inside_any_now)
                is_departure = (was_user_inside_any and not is_user_inside_any_now)

                if is_arrival or is_departure:
                    # Fetch the tracked user profile
                    stmt_user = select(User).where(User.id == device.user_id)
                    res_user = await db.execute(stmt_user)
                    tracked_user = res_user.scalar_one_or_none()
                    if not tracked_user:
                        continue

                    # Respect privacy: if the tracked user has disabled share_location, do not generate alert
                    if getattr(tracked_user, "share_location", True) is False:
                        continue

                    # Respect device-level me_only visibility if set
                    entity_name = slugify(device.device_name) or f"device_{device.id}"
                    entity_id = f"device_tracker.{entity_name}"
                    estate = await StateService.get_state(db, device.user_id, entity_id)
                    if estate:
                        attrs = estate.attributes if isinstance(estate.attributes, dict) else {}
                        if attrs.get("location_visibility") == "me_only":
                            continue

                    # Query all active circle members
                    stmt_members = select(User).join(CircleMember).where(CircleMember.circle_id == place.circle_id)
                    res_members = await db.execute(stmt_members)
                    members = res_members.scalars().all()

                    for m in members:
                        # Skip sending to the person who triggered it
                        if m.id == device.user_id:
                            continue

                        # Check notification preferences
                        if getattr(m, "notify_arrival_departure", True) is False:
                            continue

                        # Generate alert!
                        alert_type = "arrival" if is_arrival else "departure"
                        title = f"{tracked_user.display_name} arrived at {place.name}" if is_arrival else f"{tracked_user.display_name} left {place.name}"
                        message = f"{tracked_user.display_name} has arrived at {place.name}." if is_arrival else f"{tracked_user.display_name} has departed from {place.name}."

                        await AlertService.create_alert(
                            db=db,
                            alert_in=AlertCreate(
                                circle_id=place.circle_id,
                                user_id=m.id,
                                target_user_id=tracked_user.id,
                                alert_type=alert_type,
                                title=title,
                                message=message
                            )
                        )


    @staticmethod
    async def process_sensor_registration(
        db: AsyncSession,
        device: Device,
        data: SensorRegistrationData
    ) -> Dict[str, Any]:
        # Generate stable entity ID for this sensor
        dev_slug = slugify(device.device_name) or f"device_{device.id}"
        sensor_slug = slugify(data.name) or slugify(data.unique_id)
        domain = data.type if data.type in ["sensor", "binary_sensor"] else "sensor"
        entity_id = f"{domain}.{dev_slug}_{sensor_slug}"

        stmt = select(SensorRegistration).where(
            SensorRegistration.device_id == device.id,
            SensorRegistration.unique_id == data.unique_id
        )
        result = await db.execute(stmt)
        reg = result.scalar_one_or_none()

        if reg:
            # Update metadata
            reg.name = data.name
            reg.entity_id = entity_id
            reg.unit_of_measurement = data.unit_of_measurement
            reg.icon = data.icon
            reg.device_class = data.device_class
            reg.state_class = data.state_class
            reg.entity_category = data.entity_category
            reg.disabled = data.disabled
        else:
            reg = SensorRegistration(
                unique_id=data.unique_id,
                device_id=device.id,
                user_id=device.user_id,
                entity_id=entity_id,
                name=data.name,
                unit_of_measurement=data.unit_of_measurement,
                icon=data.icon,
                device_class=data.device_class,
                state_class=data.state_class,
                entity_category=data.entity_category,
                disabled=data.disabled
            )
            db.add(reg)

        await db.commit()

        # Initialize or register entity state if it does not exist
        now_state = await StateService.get_state(db, device.user_id, entity_id)
        if not now_state:
            initial_state = str(data.state) if data.state is not None else "unknown"
            attributes = {
                "friendly_name": f"{device.device_name} {data.name}",
                "device_class": data.device_class,
                "unit_of_measurement": data.unit_of_measurement,
                "icon": data.icon
            }
            if hasattr(data, "attributes") and isinstance(data.attributes, dict):
                attributes.update(data.attributes)
            attributes = {k: v for k, v in attributes.items() if v is not None}
            await StateService.set_state(
                db=db,
                user_id=device.user_id,
                entity_id=entity_id,
                state=initial_state,
                attributes=attributes,
                device_id=device.id
            )

        return {"success": True}

    @staticmethod
    async def process_sensor_state_updates(
        db: AsyncSession,
        device: Device,
        updates: List[SensorStateUpdate]
    ) -> Dict[str, Any]:
        results = {}
        for item in updates:
            # Check registration for this unique_id
            stmt = select(SensorRegistration).where(
                SensorRegistration.device_id == device.id,
                SensorRegistration.unique_id == item.unique_id
            )
            result = await db.execute(stmt)
            reg = result.scalar_one_or_none()

            if not reg:
                # If not registered, return an error or skip. Home Assistant expects register_sensor first.
                results[item.unique_id] = {"error": {"code": "not_registered", "message": "Sensor must be registered first"}}
                continue

            entity_id = reg.entity_id

            # Prepare attributes
            attributes = {
                "friendly_name": f"{device.device_name} {reg.name}",
                "unit_of_measurement": reg.unit_of_measurement,
                "icon": reg.icon,
                "device_class": reg.device_class,
                "state_class": reg.state_class
            }
            # Merge incoming attributes
            if item.attributes:
                attributes.update(item.attributes)

            # Clean out None
            attributes = {k: v for k, v in attributes.items() if v is not None}

            # Update State Engine
            await StateService.set_state(
                db=db,
                user_id=device.user_id,
                entity_id=entity_id,
                state=str(item.state),
                attributes=attributes,
                device_id=device.id
            )

            # Sync battery level / battery state updates directly to corresponding device_tracker entity
            is_battery_level_sensor = (
                reg.unique_id == "battery_level" or
                reg.device_class == "battery" or
                "battery_level" in reg.entity_id.lower()
            )
            is_battery_state_sensor = (
                reg.unique_id == "battery_state" or
                reg.device_class == "battery_state" or
                "battery_state" in reg.entity_id.lower()
            )
            is_charging_sensor = (
                reg.unique_id == "is_charging" or
                "is_charging" in reg.entity_id.lower()
            )

            if is_battery_level_sensor:
                try:
                    battery_val = float(item.state)
                except (ValueError, TypeError):
                    battery_val = None

                if battery_val is not None and 0.0 <= battery_val <= 100.0:
                    # Update Device model's last known battery & low battery status
                    device.last_known_battery = battery_val
                    await db.commit()

                    # Trigger potential alerts
                    try:
                        from app.schemas.telemetry import LocationUpdateData
                        loc_data = LocationUpdateData(battery=battery_val)
                        await TelemetryService._evaluate_low_battery(db, device, loc_data)
                    except Exception as low_batt_err:
                        import logging
                        logging.getLogger("ha_server").error(f"Error evaluating low battery from sensor update: {low_batt_err}")

                    # Find and update corresponding device_tracker entity
                    entity_name = slugify(device.device_name) or f"device_{device.id}"
                    tracker_entity_id = f"device_tracker.{entity_name}"
                    
                    tracker_state = await StateService.get_state(db, device.user_id, tracker_entity_id)
                    if tracker_state:
                        tracker_attrs = dict(tracker_state.attributes) if isinstance(tracker_state.attributes, dict) else {}
                        tracker_attrs["battery_level"] = battery_val
                        tracker_attrs["battery"] = battery_val
                        
                        await StateService.set_state(
                            db=db,
                            user_id=device.user_id,
                            entity_id=tracker_entity_id,
                            state=tracker_state.state,
                            attributes=tracker_attrs,
                            device_id=device.id,
                            latitude=tracker_state.latitude,
                            longitude=tracker_state.longitude
                        )

            elif is_battery_state_sensor and item.state:
                battery_state_val = str(item.state).strip().lower()
                is_charging_val = battery_state_val in ("charging", "full", "charging_ac", "charging_usb", "charging_wireless")
                entity_name = slugify(device.device_name) or f"device_{device.id}"
                tracker_entity_id = f"device_tracker.{entity_name}"
                
                tracker_state = await StateService.get_state(db, device.user_id, tracker_entity_id)
                if tracker_state:
                    tracker_attrs = dict(tracker_state.attributes) if isinstance(tracker_state.attributes, dict) else {}
                    tracker_attrs["battery_state"] = battery_state_val
                    tracker_attrs["battery_status"] = battery_state_val
                    tracker_attrs["charging"] = is_charging_val
                    
                    await StateService.set_state(
                        db=db,
                        user_id=device.user_id,
                        entity_id=tracker_entity_id,
                        state=tracker_state.state,
                        attributes=tracker_attrs,
                        device_id=device.id,
                        latitude=tracker_state.latitude,
                        longitude=tracker_state.longitude
                    )

            elif is_charging_sensor and item.state is not None:
                val_str = str(item.state).strip().lower()
                is_charging_val = val_str in ("on", "true", "yes", "charging")
                entity_name = slugify(device.device_name) or f"device_{device.id}"
                tracker_entity_id = f"device_tracker.{entity_name}"
                
                tracker_state = await StateService.get_state(db, device.user_id, tracker_entity_id)
                if tracker_state:
                    tracker_attrs = dict(tracker_state.attributes) if isinstance(tracker_state.attributes, dict) else {}
                    tracker_attrs["charging"] = is_charging_val
                    tracker_attrs["battery_state"] = "charging" if is_charging_val else "discharging"
                    tracker_attrs["battery_status"] = "charging" if is_charging_val else "discharging"
                    
                    await StateService.set_state(
                        db=db,
                        user_id=device.user_id,
                        entity_id=tracker_entity_id,
                        state=tracker_state.state,
                        attributes=tracker_attrs,
                        device_id=device.id,
                        latitude=tracker_state.latitude,
                        longitude=tracker_state.longitude
                    )

            results[item.unique_id] = {"success": True}

        return results

    @staticmethod
    async def _evaluate_low_battery(
        db: AsyncSession,
        device: Device,
        data: LocationUpdateData
    ) -> None:
        if not device.user_id:
            return

        if data.battery is None:
            return

        try:
            battery_val = float(data.battery)
        except (ValueError, TypeError):
            return

        if not (0.0 <= battery_val <= 100.0):
            return

        # Check for first-ever sample initialization
        if device.last_known_battery is None:
            device.last_known_battery = battery_val
            device.low_battery_alert_triggered = (battery_val < 15.0)
            await db.commit()
            return

        device.last_known_battery = battery_val
        await db.commit()

        # Recovery check
        if battery_val >= 15.0:
            if device.low_battery_alert_triggered:
                device.low_battery_alert_triggered = False
                await db.commit()
            return

        # Battery is below 15% here
        if not device.low_battery_alert_triggered:
            device.low_battery_alert_triggered = True
            await db.commit()

            from app.db.models import CircleMember, User
            from app.schemas.alerts import AlertCreate
            from app.services.alert_service import AlertService

            stmt_user = select(User).where(User.id == device.user_id)
            res_user = await db.execute(stmt_user)
            tracked_user = res_user.scalar_one_or_none()
            if not tracked_user:
                return

            stmt_circles = select(CircleMember.circle_id).where(CircleMember.user_id == device.user_id)
            res_circles = await db.execute(stmt_circles)
            circle_ids = res_circles.scalars().all()

            for circle_id in circle_ids:
                stmt_members = select(User).join(CircleMember).where(CircleMember.circle_id == circle_id)
                res_members = await db.execute(stmt_members)
                members = res_members.scalars().all()

                for m in members:
                    if m.id == device.user_id:
                        continue

                    if getattr(m, "notify_low_battery", True) is False:
                        continue

                    title = f"Low battery: {tracked_user.display_name}"
                    message = f"{tracked_user.display_name}'s {device.device_name} battery is low ({int(battery_val)}%)."

                    await AlertService.create_alert(
                        db=db,
                        alert_in=AlertCreate(
                            circle_id=circle_id,
                            user_id=m.id,
                            target_user_id=tracked_user.id,
                            alert_type="low_battery",
                            title=title,
                            message=message
                        )
                    )

    @staticmethod
    async def check_offline_devices(db: AsyncSession) -> None:
        from datetime import datetime, timezone, timedelta
        from sqlalchemy import select
        from app.db.models import Device, User, CircleMember
        from app.schemas.alerts import AlertCreate
        from app.services.alert_service import AlertService
        from app.core.config import settings

        # Get settings threshold
        threshold_minutes = settings.DEVICE_OFFLINE_THRESHOLD_MINUTES
        cutoff_time = datetime.now(timezone.utc) - timedelta(minutes=threshold_minutes)

        # Retrieve all devices
        stmt_devices = select(Device)
        res_devices = await db.execute(stmt_devices)
        devices = res_devices.scalars().all()

        for d in devices:
            if not d.user_id:
                continue

            # First observation safety: must actually have produced valid telemetry
            if not d.first_telemetry_received:
                continue

            # Check if device was seen before the cutoff
            last_seen_aware = d.last_seen_at
            if last_seen_aware.tzinfo is None:
                last_seen_aware = last_seen_aware.replace(tzinfo=timezone.utc)

            is_offline = last_seen_aware < cutoff_time

            if is_offline:
                # State transition to offline
                if not d.device_offline_alert_triggered:
                    d.device_offline_alert_triggered = True
                    await db.commit()

                    # Find tracked user
                    stmt_user = select(User).where(User.id == d.user_id)
                    res_user = await db.execute(stmt_user)
                    tracked_user = res_user.scalar_one_or_none()
                    if not tracked_user:
                        continue

                    # Determine recipients based on active circle memberships
                    stmt_circles = select(CircleMember.circle_id).where(CircleMember.user_id == d.user_id)
                    res_circles = await db.execute(stmt_circles)
                    circle_ids = res_circles.scalars().all()

                    for circle_id in circle_ids:
                        stmt_members = select(User).join(CircleMember).where(CircleMember.circle_id == circle_id)
                        res_members = await db.execute(stmt_members)
                        members = res_members.scalars().all()

                        for m in members:
                            if m.id == d.user_id:
                                continue

                            # Check recipient's notify_device_offline preference
                            if getattr(m, "notify_device_offline", True) is False:
                                continue

                            title = f"Device offline: {tracked_user.display_name}"
                            message = f"{tracked_user.display_name}'s {d.device_name} has gone offline."

                            await AlertService.create_alert(
                                db=db,
                                alert_in=AlertCreate(
                                    circle_id=circle_id,
                                    user_id=m.id,
                                    target_user_id=tracked_user.id,
                                    alert_type="device_offline",
                                    title=title,
                                    message=message
                                )
                            )


