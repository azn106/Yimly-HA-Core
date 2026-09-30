from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import EntityState
from app.services.event_service import event_bus

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
        target_timestamp = timestamp or now

        stmt = select(EntityState).where(
            EntityState.entity_id == entity_id
        )
        result = await db.execute(stmt)
        entity = result.scalar_one_or_none()

        # Enforce central architectural freshness check to prevent older location points
        # from overwriting current EntityState coordinates
        if entity and entity.last_updated:
            entity_updated = entity.last_updated
            t_ts = target_timestamp
            if isinstance(entity_updated, str):
                try:
                    entity_updated = datetime.fromisoformat(entity_updated.replace("Z", "+00:00"))
                except Exception:
                    entity_updated = None
            if isinstance(t_ts, str):
                try:
                    t_ts = datetime.fromisoformat(t_ts.replace("Z", "+00:00"))
                except Exception:
                    t_ts = None

            if entity_updated and t_ts:
                # Timezone safety: align naive vs aware datetimes
                if entity_updated.tzinfo is None and t_ts.tzinfo is not None:
                    t_ts = t_ts.replace(tzinfo=None)
                elif entity_updated.tzinfo is not None and t_ts.tzinfo is None:
                    entity_updated = entity_updated.replace(tzinfo=None)

                if t_ts < entity_updated:
                    # Reject mutation from an older GPS fix. Retain existing state and skip broadcast.
                    return entity

        old_state = None
        if entity:
            old_state = {
                "entity_id": entity.entity_id,
                "state": entity.state,
                "attributes": entity.attributes,
                "last_changed": entity.last_changed.isoformat() if hasattr(entity.last_changed, "isoformat") else str(entity.last_changed or now.isoformat()),
                "last_updated": entity.last_updated.isoformat() if hasattr(entity.last_updated, "isoformat") else str(entity.last_updated or now.isoformat())
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
                entity_updated = entity.last_updated
                t_ts = target_timestamp
                if isinstance(entity_updated, str):
                    try:
                        entity_updated = datetime.fromisoformat(entity_updated.replace("Z", "+00:00"))
                    except Exception:
                        entity_updated = None
                if isinstance(t_ts, str):
                    try:
                        t_ts = datetime.fromisoformat(t_ts.replace("Z", "+00:00"))
                    except Exception:
                        t_ts = None

                if entity_updated and t_ts:
                    if entity_updated.tzinfo is None and t_ts.tzinfo is not None:
                        t_ts = t_ts.replace(tzinfo=None)
                    elif entity_updated.tzinfo is not None and t_ts.tzinfo is None:
                        entity_updated = entity_updated.replace(tzinfo=None)

                    if t_ts < entity_updated:
                        return entity

                old_state = {
                    "entity_id": entity.entity_id,
                    "state": entity.state,
                    "attributes": entity.attributes,
                    "last_changed": entity.last_changed.isoformat() if hasattr(entity.last_changed, "isoformat") else str(entity.last_changed or now.isoformat()),
                    "last_updated": entity.last_updated.isoformat() if hasattr(entity.last_updated, "isoformat") else str(entity.last_updated or now.isoformat())
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
            "last_changed": entity.last_changed.isoformat() if hasattr(entity.last_changed, "isoformat") else str(entity.last_changed or now.isoformat()),
            "last_updated": entity.last_updated.isoformat() if hasattr(entity.last_updated, "isoformat") else str(entity.last_updated or now.isoformat())
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
            "last_changed": entity.last_changed.isoformat() if entity.last_changed else None,
            "last_updated": entity.last_updated.isoformat() if entity.last_updated else None
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

