import bcrypt
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
import jwt
from app.core.config import settings
from app.core.logging import logger

def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        plain_bytes = plain_password.encode('utf-8')
        hashed_bytes = hashed_password.encode('utf-8')
        return bcrypt.checkpw(plain_bytes, hashed_bytes)
    except Exception as e:
        logger.error(f"Error verifying password: {e}")
        return False

def get_password_hash(password: str) -> str:
    pwd_bytes = password.encode('utf-8')
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(pwd_bytes, salt)
    return hashed.decode('utf-8')


def create_jwt_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    import secrets
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": int(expire.timestamp())})
    if "iat" not in to_encode:
        to_encode.update({"iat": int(datetime.now(timezone.utc).timestamp())})
    if "jti" not in to_encode:
        to_encode.update({"jti": secrets.token_hex(16)})
    return jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)

def verify_jwt_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        # Decode and validate signature/expiration
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
            options={"require": ["exp", "sub"]}
        )
        return payload
    except jwt.ExpiredSignatureError:
        logger.warning("Token signature has expired")
        return None
    except jwt.InvalidSignatureError:
        logger.warning("Token signature is invalid")
        return None
    except jwt.InvalidTokenError as e:
        logger.warning(f"Invalid token: {e}")
        return None
    except Exception as e:
        logger.error(f"Error decoding token: {e}")
        return None
