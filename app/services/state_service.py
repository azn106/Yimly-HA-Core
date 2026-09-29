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
        longitude: Optional[float] = None
    ) -> EntityState:
        domain = entity_id.split(".", 1)[0] if "." in entity_id else "sensor"
        now = datetime.now(timezone.utc)

        stmt = select(EntityState).where(
            EntityState.entity_id == entity_id
        )
        result = await db.execute(stmt)
        entity = result.scalar_one_or_none()

        old_state = None
        if entity:
            old_state = {
                "entity_id": entity.entity_id,
                "state": entity.state,
                "attributes": entity.attributes,
                "last_changed": entity.last_changed.isoformat() if entity.last_changed else now.isoformat(),
                "last_updated": entity.last_updated.isoformat() if entity.last_updated else now.isoformat()
            }
            entity.user_id = user_id
            if device_id is not None:
                entity.device_id = device_id
            entity.domain = domain
            if entity.state != str(state):
                entity.last_changed = now
            entity.last_updated = now
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
                last_changed=now,
                last_updated=now
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
                old_state = {
                    "entity_id": entity.entity_id,
                    "state": entity.state,
                    "attributes": entity.attributes,
                    "last_changed": entity.last_changed.isoformat() if entity.last_changed else now.isoformat(),
                    "last_updated": entity.last_updated.isoformat() if entity.last_updated else now.isoformat()
                }
                entity.user_id = user_id
                if device_id is not None:
                    entity.device_id = device_id
                entity.domain = domain
                if entity.state != str(state):
                    entity.last_changed = now
                entity.last_updated = now
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
                        last_changed=now,
                        last_updated=now
                    )

        new_state = {
            "entity_id": entity.entity_id,
            "state": entity.state,
            "attributes": entity.attributes,
            "last_changed": entity.last_changed.isoformat(),
            "last_updated": entity.last_updated.isoformat()
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

