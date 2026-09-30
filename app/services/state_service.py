from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import EntityState
from app.services.event_service import event_bus


def normalize_utc_datetime(dt_val: Any) -> Optional[datetime]:
    """Safely normalizes a datetime, ISO string, or None into a UTC-aware datetime object."""
    if dt_val is None:
        return None
    if isinstance(dt_val, datetime):
        if dt_val.tzinfo is None:
            return dt_val.replace(tzinfo=timezone.utc)
        return dt_val.astimezone(timezone.utc)
    if isinstance(dt_val, str):
        val = dt_val.strip()
        if not val:
            return None
        if val.endswith("Z"):
            val = val[:-1] + "+00:00"
        try:
            d = datetime.fromisoformat(val)
            if d.tzinfo is None:
                return d.replace(tzinfo=timezone.utc)
            return d.astimezone(timezone.utc)
        except Exception:
            return None
    return None


def safe_isoformat(dt_val: Any, fallback: Optional[str] = None) -> Optional[str]:
    """Safely serializes a datetime, ISO string, or fallback without raising AttributeError."""
    if dt_val is None:
        return fallback
    if hasattr(dt_val, "isoformat"):
        return dt_val.isoformat()
    return str(dt_val)


class StateService:
    @staticmethod
    async def get_state(db: AsyncSession, user_id: int, entity_id: str) -> Optional[EntityState]:
        stmt = select(EntityState).where(
            EntityState.entity_id == entity_id
        )
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    @staticmethod
    async def get_all_states(db: AsyncSession, user_id: int) -> List[EntityState]:
        stmt = select(EntityState).where(EntityState.user_id == user_id)
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def set_state(
        db: AsyncSession,
        user_id: int,
        entity_id: str,
        state: str,
        attributes: Dict[str, Any],
        device_id: Optional[int] = None,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
        timestamp: Optional[datetime] = None
    ) -> EntityState:
        domain = entity_id.split(".", 1)[0] if "." in entity_id else "sensor"
        now = datetime.now(timezone.utc)
        target_timestamp = normalize_utc_datetime(timestamp) or now

        stmt = select(EntityState).where(
            EntityState.entity_id == entity_id
        )
        result = await db.execute(stmt)
        entity = result.scalar_one_or_none()

        # Enforce central architectural freshness check to prevent older location points
        # from overwriting current EntityState coordinates
        if entity and entity.last_updated is not None:
            entity_updated = normalize_utc_datetime(entity.last_updated)
            if entity_updated is not None and target_timestamp < entity_updated:
                # Reject mutation from an older GPS fix. Retain existing state and skip broadcast.
                return entity

        old_state = None
        if entity:
            old_state = {
                "entity_id": entity.entity_id,
                "state": entity.state,
                "attributes": entity.attributes,
                "last_changed": safe_isoformat(entity.last_changed, now.isoformat()),
                "last_updated": safe_isoformat(entity.last_updated, now.isoformat())
            }
            entity.user_id = user_id
            if device_id is not None:
                entity.device_id = device_id
            entity.domain = domain
            if entity.state != str(state):
                entity.last_changed = target_timestamp
            entity.last_updated = target_timestamp
            entity.state = str(state)
            entity.attributes = attributes
            if latitude is not None:
                entity.latitude = latitude
            if longitude is not None:
                entity.longitude = longitude
        else:
            entity = EntityState(
                entity_id=entity_id,
                device_id=device_id,
                user_id=user_id,
                domain=domain,
                state=str(state),
                attributes=attributes,
                latitude=latitude,
                longitude=longitude,
                last_changed=target_timestamp,
                last_updated=target_timestamp
            )
            db.add(entity)

        try:
            await db.commit()
            await db.refresh(entity)
        except Exception:
            await db.rollback()
            db.expunge_all()
            # Race condition handling: re-query existing entity by entity_id and update
            stmt = select(EntityState).where(
                EntityState.entity_id == entity_id
            )
            result = await db.execute(stmt)
            entity = result.scalar_one_or_none()
            if entity:
                entity_updated = normalize_utc_datetime(entity.last_updated)
                if entity_updated is not None and target_timestamp < entity_updated:
                    return entity

                old_state = {
                    "entity_id": entity.entity_id,
                    "state": entity.state,
                    "attributes": entity.attributes,
                    "last_changed": safe_isoformat(entity.last_changed, now.isoformat()),
                    "last_updated": safe_isoformat(entity.last_updated, now.isoformat())
                }
                entity.user_id = user_id
                if device_id is not None:
                    entity.device_id = device_id
                entity.domain = domain
                if entity.state != str(state):
                    entity.last_changed = target_timestamp
                entity.last_updated = target_timestamp
                entity.state = str(state)
                entity.attributes = attributes
                if latitude is not None:
                    entity.latitude = latitude
                if longitude is not None:
                    entity.longitude = longitude
                try:
                    await db.commit()
                    await db.refresh(entity)
                except Exception:
                    await db.rollback()
                    db.expunge_all()
            else:
                # Fallback: re-query or construct instance safely
                stmt = select(EntityState).where(
                    EntityState.entity_id == entity_id
                )
                res_fallback = await db.execute(stmt)
                entity = res_fallback.scalar_one_or_none()
                if not entity:
                    entity = EntityState(
                        entity_id=entity_id,
                        device_id=device_id,
                        user_id=user_id,
                        domain=domain,
                        state=str(state),
                        attributes=attributes,
                        latitude=latitude,
                        longitude=longitude,
                        last_changed=target_timestamp,
                        last_updated=target_timestamp
                    )

        new_state = {
            "entity_id": entity.entity_id,
            "state": entity.state,
            "attributes": entity.attributes,
            "last_changed": safe_isoformat(entity.last_changed, now.isoformat()),
            "last_updated": safe_isoformat(entity.last_updated, now.isoformat())
        }

        # Fire state_changed event
        await event_bus.fire(
            event_type="state_changed",
            event_data={
                "entity_id": entity_id,
                "old_state": old_state,
                "new_state": new_state
            },
            user_id=user_id
        )

        return entity

    @staticmethod
    async def delete_state(db: AsyncSession, user_id: int, entity_id: str) -> bool:
        stmt = select(EntityState).where(EntityState.entity_id == entity_id)
        result = await db.execute(stmt)
        entity = result.scalar_one_or_none()
        if not entity:
            return False

        old_state = {
            "entity_id": entity.entity_id,
            "state": entity.state,
            "attributes": entity.attributes,
            "last_changed": safe_isoformat(entity.last_changed),
            "last_updated": safe_isoformat(entity.last_updated)
        }

        await db.delete(entity)
        await db.commit()

        # Fire state_changed event with new_state=None indicating removal
        await event_bus.fire(
            event_type="state_changed",
            event_data={
                "entity_id": entity_id,
                "old_state": old_state,
                "new_state": None
            },
            user_id=user_id
        )
        return True
