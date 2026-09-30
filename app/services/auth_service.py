from typing import Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import User
from app.core.security import get_password_hash, verify_password
from app.schemas.auth import UserCreate

class AuthService:
    @staticmethod
    async def get_user_by_username(db: AsyncSession, username: str) -> Optional[User]:
        normalized = username.lower()
        stmt = select(User).where(User.username == normalized)
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    @staticmethod
    async def create_user(db: AsyncSession, user_in: UserCreate) -> User:
        password_hash = get_password_hash(user_in.password)
        normalized = user_in.username.lower()
        user = User(
            username=normalized,
            password_hash=password_hash,
            display_name=user_in.display_name,
            is_active=True
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
        return user

    @staticmethod
    async def authenticate_user(db: AsyncSession, username: str, password: str) -> Optional[User]:
        normalized = username.lower()
        user = await AuthService.get_user_by_username(db, normalized)
        if not user:
            # Perform dummy check to mitigate timing analysis attacks
            verify_password(password, "$2b$12$z/mZp7Yshq4p9gC69g8oBeM1qCO0fN1s8Z5mK3Q0A9uT9f8R7e7sO")
            return None
        if not verify_password(password, user.password_hash):
            return None
        if not user.is_active:
            return None
        return user

    @staticmethod
    async def delete_user_account(db: AsyncSession, user: User) -> None:
        import os
        from app.db.models import (
            EntityState, Device, LocationHistory, SensorRegistration,
            GeofenceState, Alert, EventRecord, RefreshToken, RevokedToken,
            AuthorizationCode, Circle, CircleMember
        )
        from app.services.event_service import event_bus

        # 1. Collect all entity IDs owned by this user for WebSocket state broadcast
        stmt_entities = select(EntityState.entity_id).where(EntityState.user_id == user.id)
        res_entities = await db.execute(stmt_entities)
        deleted_entity_ids = list(res_entities.scalars().all())

        # 2. Handle Circles owned by user
        stmt_owned_circles = select(Circle).where(Circle.owner_id == user.id)
        res_owned_circles = await db.execute(stmt_owned_circles)
        owned_circles = res_owned_circles.scalars().all()

        for circle in owned_circles:
            # Query other members who are registered users
            stmt_other = (
                select(CircleMember)
                .where(CircleMember.circle_id == circle.id, CircleMember.user_id != user.id, CircleMember.user_id.is_not(None))
                .order_by(CircleMember.joined_at.asc())
            )
            res_other = await db.execute(stmt_other)
            other_members = res_other.scalars().all()

            if other_members and len(other_members) > 0:
                # Reassign circle ownership to the oldest remaining member
                new_owner_member = other_members[0]
                circle.owner_id = new_owner_member.user_id
                db.add(circle)
            else:
                # No remaining registered users, delete the entire circle
                await db.delete(circle)

        # 3. Clean up any other CircleMember records where user was a member
        stmt_member = select(CircleMember).where(CircleMember.user_id == user.id)
        res_member = await db.execute(stmt_member)
        for cm in res_member.scalars().all():
            await db.delete(cm)

        # 4. Clean up any CircleMember assigned_entity_id pointing to user's entities
        if deleted_entity_ids:
            stmt_assigned = select(CircleMember).where(CircleMember.assigned_entity_id.in_(deleted_entity_ids))
            res_assigned = await db.execute(stmt_assigned)
            for cm in res_assigned.scalars().all():
                cm.assigned_entity_id = None
                db.add(cm)

        # 5. Clean up profile picture file on disk if any
        if user.profile_picture_url:
            try:
                from app.api.auth import get_profile_pictures_dir
                old_file_name = os.path.basename(user.profile_picture_url)
                for check_dir in [get_profile_pictures_dir(), os.path.join(os.getcwd(), "uploads", "profile_pictures")]:
                    old_file_path = os.path.join(check_dir, old_file_name)
                    if os.path.exists(old_file_path):
                        try:
                            os.remove(old_file_path)
                        except Exception:
                            pass
            except Exception:
                pass

        # 6. Delete user (cascades to devices, entities, location history, tokens, alerts, geofences)
        await db.delete(user)
        await db.commit()

        # 7. Fire WebSocket state_changed event with new_state=None for all removed entities
        for ent_id in deleted_entity_ids:
            try:
                await event_bus.fire(
                    "state_changed",
                    {
                        "entity_id": ent_id,
                        "old_state": {"entity_id": ent_id},
                        "new_state": None
                    },
                    user_id=user.id
                )
            except Exception:
                pass

