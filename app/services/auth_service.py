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

