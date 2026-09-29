import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import settings
from app.core.logging import logger
from app.core.security import verify_jwt_token
from app.db.models import AuthorizationCode, RefreshToken, RevokedToken, User

def _to_naive_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt

class TokenService:
    @staticmethod
    def hash_value(value: str) -> str:
        return hashlib.sha256(value.encode('utf-8')).hexdigest()

    @staticmethod
    async def create_authorization_code(
        db: AsyncSession,
        user_id: int,
        client_id: str,
        redirect_uri: str
    ) -> str:
        raw_code = secrets.token_urlsafe(32)
        code_hash = TokenService.hash_value(raw_code)
        now_utc = datetime.now(timezone.utc)
        expires_at = now_utc + timedelta(seconds=settings.AUTH_CODE_EXPIRE_SECONDS)

        auth_code = AuthorizationCode(
            code_hash=code_hash,
            user_id=user_id,
            client_id=client_id,
            redirect_uri=redirect_uri,
            expires_at=expires_at,
            created_at=now_utc
        )
        db.add(auth_code)
        await db.commit()
        return raw_code

    @staticmethod
    async def redeem_authorization_code(
        db: AsyncSession,
        raw_code: str,
        client_id: str,
        redirect_uri: Optional[str] = None
    ) -> Optional[int]:
        code_hash = TokenService.hash_value(raw_code)
        stmt = select(AuthorizationCode).where(
            AuthorizationCode.code_hash == code_hash,
            AuthorizationCode.client_id == client_id
        )
        result = await db.execute(stmt)
        auth_code = result.scalar_one_or_none()

        if not auth_code:
            logger.warning("Authorization code not found or client_id mismatch.")
            return None

        # Enforce exact redirect_uri match if redirect_uri was passed during exchange
        if redirect_uri is not None and auth_code.redirect_uri != redirect_uri:
            logger.warning(f"Redirect URI mismatch: expected {auth_code.redirect_uri}, got {redirect_uri}")
            return None

        now_naive = _to_naive_utc(datetime.now(timezone.utc))
        code_expires_naive = _to_naive_utc(auth_code.expires_at)

        # Single-use and expiration enforcement
        if auth_code.used_at is not None:
            logger.warning("Attempted replay of already consumed authorization code.")
            return None

        if code_expires_naive and code_expires_naive < now_naive:
            logger.warning("Authorization code has expired.")
            return None

        # Atomically consume authorization code
        auth_code.used_at = datetime.now(timezone.utc)

        # Verify associated user account is active
        user = await db.get(User, auth_code.user_id)
        if not user or not user.is_active:
            logger.warning(f"User {auth_code.user_id} for authorization code is invalid or deactivated.")
            await db.commit()
            return None

        await db.commit()
        return auth_code.user_id

    @staticmethod
    async def create_refresh_token(
        db: AsyncSession,
        user_id: int,
        client_id: str
    ) -> str:
        raw_token = secrets.token_urlsafe(40)
        token_hash = TokenService.hash_value(raw_token)
        now_utc = datetime.now(timezone.utc)
        expires_at = now_utc + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)

        refresh_token = RefreshToken(
            token_hash=token_hash,
            user_id=user_id,
            client_id=client_id,
            expires_at=expires_at,
            created_at=now_utc
        )
        db.add(refresh_token)
        await db.commit()
        return raw_token

    @staticmethod
    async def redeem_refresh_token(
        db: AsyncSession,
        raw_token: str,
        client_id: str
    ) -> Optional[int]:
        token_hash = TokenService.hash_value(raw_token)
        stmt = select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.client_id == client_id
        )
        result = await db.execute(stmt)
        ref_token = result.scalar_one_or_none()

        if not ref_token:
            logger.warning("Refresh token not found or client_id mismatch.")
            return None

        now_naive = _to_naive_utc(datetime.now(timezone.utc))
        token_expires_naive = _to_naive_utc(ref_token.expires_at)

        # Revocation and expiration checks
        if ref_token.revoked_at is not None:
            logger.warning("Attempted use of revoked refresh token.")
            return None

        if token_expires_naive and token_expires_naive < now_naive:
            logger.warning("Refresh token has expired.")
            return None

        # Verify user exists and is active
        user = await db.get(User, ref_token.user_id)
        if not user or not user.is_active:
            logger.warning(f"User {ref_token.user_id} for refresh token is deactivated or deleted.")
            return None

        return ref_token.user_id

    @staticmethod
    async def revoke_refresh_token(
        db: AsyncSession,
        raw_token: str,
        client_id: Optional[str] = None
    ) -> bool:
        token_hash = TokenService.hash_value(raw_token)
        stmt = select(RefreshToken).where(RefreshToken.token_hash == token_hash)
        if client_id:
            stmt = stmt.where(RefreshToken.client_id == client_id)
        result = await db.execute(stmt)
        ref_token = result.scalar_one_or_none()

        if not ref_token:
            return False

        if ref_token.revoked_at is None:
            ref_token.revoked_at = datetime.now(timezone.utc)
            await db.commit()
            return True

        return True

    @staticmethod
    async def revoke_access_token(
        db: AsyncSession,
        raw_token: str,
        jti: Optional[str] = None,
        user_id: Optional[int] = None,
        expires_at: Optional[datetime] = None
    ) -> bool:
        identifier = jti or TokenService.hash_value(raw_token)

        # Check if already recorded in RevokedToken
        stmt = select(RevokedToken).where(RevokedToken.token_identifier == identifier)
        res = await db.execute(stmt)
        existing = res.scalar_one_or_none()
        if existing:
            return True

        if expires_at is None:
            expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)

        rev_token = RevokedToken(
            token_identifier=identifier,
            token_type="access",
            user_id=user_id,
            expires_at=expires_at,
            revoked_at=datetime.now(timezone.utc)
        )
        db.add(rev_token)
        await db.commit()
        return True

    @staticmethod
    async def revoke_token(
        db: AsyncSession,
        raw_token: str,
        client_id: Optional[str] = None
    ) -> bool:
        """
        RFC 7009 compliant token revocation:
        Attempts to revoke as refresh token first. If not found, checks if it's an access token.
        """
        if not raw_token:
            return False

        # Try revoking as refresh token
        revoked_rf = await TokenService.revoke_refresh_token(db, raw_token, client_id)
        if revoked_rf:
            return True

        # Try verifying as JWT access token
        payload = verify_jwt_token(raw_token)
        if payload:
            jti = payload.get("jti")
            sub = payload.get("sub")
            exp_ts = payload.get("exp")
            user_id = int(sub) if sub and sub.isdigit() else None
            exp_dt = datetime.fromtimestamp(exp_ts, tz=timezone.utc) if exp_ts else None
            return await TokenService.revoke_access_token(
                db=db,
                raw_token=raw_token,
                jti=jti,
                user_id=user_id,
                expires_at=exp_dt
            )

        # Fallback: record token hash in revoked tokens
        return await TokenService.revoke_access_token(db=db, raw_token=raw_token)

    @staticmethod
    async def is_token_revoked(
        db: AsyncSession,
        jti: Optional[str] = None,
        token_hash: Optional[str] = None
    ) -> bool:
        """Checks if a JTI or token hash has been explicitly revoked."""
        identifiers = []
        if jti:
            identifiers.append(jti)
        if token_hash:
            identifiers.append(token_hash)

        if not identifiers:
            return False

        stmt = select(RevokedToken).where(RevokedToken.token_identifier.in_(identifiers))
        res = await db.execute(stmt)
        return res.scalar_one_or_none() is not None

    @staticmethod
    async def cleanup_expired_tokens(db: AsyncSession) -> None:
        """Purges expired authorization codes, expired revoked records, and old tokens."""
        now_naive = _to_naive_utc(datetime.now(timezone.utc))

        try:
            # Delete expired auth codes
            await db.execute(delete(AuthorizationCode).where(AuthorizationCode.expires_at < now_naive))
            # Delete expired revoked tokens
            await db.execute(delete(RevokedToken).where(RevokedToken.expires_at < now_naive))
            # Delete expired refresh tokens (or revoked more than 30 days ago)
            await db.execute(delete(RefreshToken).where(RefreshToken.expires_at < now_naive))
            await db.commit()
        except Exception as e:
            logger.warning(f"Error cleaning up expired tokens: {e}")
