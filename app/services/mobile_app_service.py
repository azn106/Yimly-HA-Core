import hashlib
import secrets
from typing import Optional
from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.logging import logger
from app.db.models import Device, EntityState, SensorRegistration, LocationHistory, GeofenceState
from app.schemas.mobile_app import RegistrationRequest
from app.services.encryption_service import EncryptionService

class MobileAppService:
    @staticmethod
    def hash_value(value: str) -> str:
        return hashlib.sha256(value.encode('utf-8')).hexdigest()

    @staticmethod
    async def register_device(
        db: AsyncSession,
        user_id: int,
        req: RegistrationRequest
    ) -> Device:
        # Search for existing physical device by unique device_id across all users
        stmt = select(Device).where(Device.device_id == req.device_id)
        result = await db.execute(stmt)
        existing_device = result.scalar_one_or_none()

        # Encryption negotiation:
        # If client sends supports_encryption=True, generate a cryptographically secure 32-character secret (256-bit key).
        # If supports_encryption=False, encryption is explicitly disabled (secret is None).
        if req.supports_encryption:
            raw_secret = EncryptionService.generate_secret()
            secret_hash = MobileAppService.hash_value(raw_secret)
            webhook_secret = raw_secret
        else:
            raw_secret = None
            secret_hash = ""
            webhook_secret = None

        if existing_device:
            if existing_device.user_id == user_id:
                # 1. Same-User Re-registration:
                # Update device metadata and refresh encryption secret if requested.
                # Keep existing webhook_id active unless encryption renegotiation requires fresh parameters.
                logger.info(f"Same-user re-registration for device_id: {req.device_id} (user_id: {user_id})")
                existing_device.app_id = req.app_id
                existing_device.app_name = req.app_name
                existing_device.app_version = req.app_version
                existing_device.device_name = req.device_name
                existing_device.manufacturer = req.manufacturer
                existing_device.model = req.model
                existing_device.os_name = req.os_name
                existing_device.os_version = req.os_version
                existing_device.supports_encryption = req.supports_encryption
                existing_device.app_data = req.app_data
                existing_device.webhook_secret = webhook_secret
                existing_device.webhook_secret_hash = secret_hash
                device = existing_device
            else:
                # 2. Cross-User Device Reassignment (Account Switching):
                # Physical device transferred to a different user.
                old_user_id = existing_device.user_id
                logger.info(f"Cross-user device transfer for device_id: {req.device_id} from user {old_user_id} to user {user_id}")

                # Generate brand new webhook_id (invalidates old webhook identity so old webhook returns 410)
                new_webhook_id = secrets.token_urlsafe(32)

                # Prevent the previous user from retaining access; clean up previous location history for this device
                await db.execute(delete(LocationHistory).where(LocationHistory.device_id == existing_device.id))
                await db.execute(delete(GeofenceState).where(GeofenceState.device_id == existing_device.id))

                # Clean up old entities and sensors on physical device reassignment
                await db.execute(delete(SensorRegistration).where(SensorRegistration.device_id == existing_device.id))
                await db.execute(delete(EntityState).where(EntityState.device_id == existing_device.id))

                # Update device owner & metadata
                existing_device.user_id = user_id
                existing_device.webhook_id = new_webhook_id
                existing_device.app_id = req.app_id
                existing_device.app_name = req.app_name
                existing_device.app_version = req.app_version
                existing_device.device_name = req.device_name
                existing_device.manufacturer = req.manufacturer
                existing_device.model = req.model
                existing_device.os_name = req.os_name
                existing_device.os_version = req.os_version
                existing_device.supports_encryption = req.supports_encryption
                existing_device.app_data = req.app_data
                existing_device.webhook_secret = webhook_secret
                existing_device.webhook_secret_hash = secret_hash
                existing_device.first_telemetry_received = False
                existing_device.low_battery_alert_triggered = False
                existing_device.device_offline_alert_triggered = False
                existing_device.last_known_battery = None
                device = existing_device
        else:
            # 3. Brand New Device Registration:
            logger.info(f"First registration for device_id: {req.device_id} (user_id: {user_id})")
            webhook_id = secrets.token_urlsafe(32)
            device = Device(
                user_id=user_id,
                device_id=req.device_id,
                app_id=req.app_id,
                app_name=req.app_name,
                app_version=req.app_version,
                device_name=req.device_name,
                manufacturer=req.manufacturer,
                model=req.model,
                os_name=req.os_name,
                os_version=req.os_version,
                supports_encryption=req.supports_encryption,
                app_data=req.app_data,
                webhook_id=webhook_id,
                webhook_secret_hash=secret_hash,
                webhook_secret=webhook_secret,
                first_telemetry_received=False,
                low_battery_alert_triggered=False,
                device_offline_alert_triggered=False
            )
            db.add(device)

        await db.commit()
        await db.refresh(device)

        # Stash raw secret dynamically (not persisted in plain API reads) to return in RegistrationResponse once
        setattr(device, "raw_secret", raw_secret)
        return device

    @staticmethod
    async def get_device_by_webhook(db: AsyncSession, webhook_id: str) -> Optional[Device]:
        stmt = select(Device).where(Device.webhook_id == webhook_id)
        result = await db.execute(stmt)
        return result.scalar_one_or_none()
