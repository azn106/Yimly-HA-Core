import os
import secrets
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    APP_ENV: str = "production"
    DATA_DIR: str = os.getenv("DATA_DIR", "/data" if os.path.exists("/data") else ".")
    DATABASE_URL: str = ""
    JWT_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 43200  # 30 days
    REFRESH_TOKEN_EXPIRE_DAYS: int = 365
    AUTH_CODE_EXPIRE_SECONDS: int = 300
    BASE_URL: str = ""
    UPLOADS_DIR: str = ""
    DEVICE_OFFLINE_THRESHOLD_MINUTES: int = 15

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"

settings = Settings()

# Ensure DATA_DIR directory exists
if settings.DATA_DIR and not os.path.exists(settings.DATA_DIR):
    try:
        os.makedirs(settings.DATA_DIR, exist_ok=True)
    except Exception:
        pass

# Configure default DATABASE_URL if empty
if not settings.DATABASE_URL:
    db_path = os.path.join(settings.DATA_DIR, "ha_server.db")
    settings.DATABASE_URL = f"sqlite+aiosqlite:///{db_path}"

# Configure default UPLOADS_DIR if empty
if not settings.UPLOADS_DIR:
    settings.UPLOADS_DIR = os.path.abspath(os.path.join(settings.DATA_DIR, "uploads"))
else:
    settings.UPLOADS_DIR = os.path.abspath(settings.UPLOADS_DIR)

# Post-processing secret key if not set
if not settings.JWT_SECRET_KEY:
    secret_file = os.path.join(settings.DATA_DIR, "jwt_secret.key")
    if os.path.exists(secret_file):
        try:
            with open(secret_file, "r") as f:
                settings.JWT_SECRET_KEY = f.read().strip()
        except Exception:
            settings.JWT_SECRET_KEY = secrets.token_hex(32)
    else:
        settings.JWT_SECRET_KEY = secrets.token_hex(32)
        try:
            with open(secret_file, "w") as f:
                f.write(settings.JWT_SECRET_KEY)
        except Exception:
            pass

# Ensure BASE_URL is set from APP_URL or fall back
if not settings.BASE_URL:
    settings.BASE_URL = os.getenv("APP_URL", "").rstrip("/")
    if not settings.BASE_URL:
        settings.BASE_URL = "http://localhost:3000"
