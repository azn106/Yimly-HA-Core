import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from app.core.config import settings
from app.core.logging import setup_logging, logger
from app.db.database import Base, engine
from app.api import auth, rest, mobile_app, webhook, websocket, circles, places, alerts, traccar

# Initialize logging configuration
setup_logging()

app = FastAPI(
    title="Home Assistant Companion App Compatible Server",
    description="A fully featured production-ready compatible backend server.",
    version="1.0.0",
)

# CORS config
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def on_startup() -> None:
    logger.info("Starting up Home Assistant compatible server backend...")
    try:
        async with engine.begin() as conn:
            # Idempotently create tables
            await conn.run_sync(Base.metadata.create_all)
            
            # Dynamically migrate avatar_color if it doesn't exist
            from sqlalchemy import text
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN avatar_color VARCHAR(50);"))
                logger.info("Database migration: Added avatar_color column to users table.")
            except Exception:
                # Column likely already exists, ignore
                pass

            # Dynamically migrate profile_picture_url if it doesn't exist
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN profile_picture_url VARCHAR(500);"))
                logger.info("Database migration: Added profile_picture_url column to users table.")
            except Exception:
                # Column likely already exists, ignore
                pass

            # Dynamically migrate map_style if it doesn't exist
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN map_style VARCHAR(50) DEFAULT 'osm';"))
                logger.info("Database migration: Added map_style column to users table.")
            except Exception:
                # Column likely already exists, ignore
                pass

            # Dynamically migrate map_selected_icon_size if it doesn't exist
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN map_selected_icon_size INTEGER DEFAULT 48;"))
                logger.info("Database migration: Added map_selected_icon_size column to users table.")
            except Exception:
                # Column likely already exists, ignore
                pass

            # Dynamically migrate map_unselected_icon_size if it doesn't exist
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN map_unselected_icon_size INTEGER DEFAULT 36;"))
                logger.info("Database migration: Added map_unselected_icon_size column to users table.")
            except Exception:
                # Column likely already exists, ignore
                pass

            # Dynamically migrate share_location if it doesn't exist
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN share_location BOOLEAN DEFAULT 1;"))
                logger.info("Database migration: Added share_location column to users table.")
            except Exception:
                # Column likely already exists, ignore
                pass

            # Dynamically migrate save_location_history if it doesn't exist
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN save_location_history BOOLEAN DEFAULT 1;"))
                logger.info("Database migration: Added save_location_history column to users table.")
            except Exception:
                # Column likely already exists, ignore
                pass

            # Dynamically migrate history_retention if it doesn't exist
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN history_retention VARCHAR(20) DEFAULT '30d';"))
                logger.info("Database migration: Added history_retention column to users table.")
            except Exception:
                # Column likely already exists, ignore
                pass

            # Dynamically migrate location_update_frequency if it doesn't exist
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN location_update_frequency VARCHAR(20) DEFAULT 'realtime';"))
                logger.info("Database migration: Added location_update_frequency column to users table.")
            except Exception:
                # Column likely already exists, ignore
                pass

            # Dynamically migrate notification preference columns if they don't exist
            for col in ["notify_push", "notify_arrival_departure", "notify_stop_sharing", "notify_low_battery", "notify_device_offline"]:
                try:
                    await conn.execute(text(f"ALTER TABLE users ADD COLUMN {col} BOOLEAN DEFAULT 1;"))
                    logger.info(f"Database migration: Added {col} column to users table.")
                except Exception:
                    # Column likely already exists, ignore
                    pass

            # Dynamically migrate Device low_battery_alert_triggered
            try:
                await conn.execute(text("ALTER TABLE devices ADD COLUMN low_battery_alert_triggered BOOLEAN DEFAULT 0;"))
                logger.info("Database migration: Added low_battery_alert_triggered column to devices table.")
            except Exception:
                pass

            # Dynamically migrate Device last_known_battery
            try:
                await conn.execute(text("ALTER TABLE devices ADD COLUMN last_known_battery FLOAT;"))
                logger.info("Database migration: Added last_known_battery column to devices table.")
            except Exception:
                pass

            # Dynamically migrate Device device_offline_alert_triggered
            try:
                await conn.execute(text("ALTER TABLE devices ADD COLUMN device_offline_alert_triggered BOOLEAN DEFAULT 0;"))
                logger.info("Database migration: Added device_offline_alert_triggered column to devices table.")
            except Exception:
                pass

            # Dynamically migrate Device first_telemetry_received
            try:
                await conn.execute(text("ALTER TABLE devices ADD COLUMN first_telemetry_received BOOLEAN DEFAULT 0;"))
                logger.info("Database migration: Added first_telemetry_received column to devices table.")
            except Exception:
                pass

            # Dynamically migrate Device webhook_secret
            try:
                await conn.execute(text("ALTER TABLE devices ADD COLUMN webhook_secret VARCHAR(255);"))
                logger.info("Database migration: Added webhook_secret column to devices table.")
            except Exception:
                pass

            # Dynamically migrate users.assigned_entity_id
            try:
                await conn.execute(text("ALTER TABLE users ADD COLUMN assigned_entity_id VARCHAR(255);"))
                logger.info("Database migration: Added assigned_entity_id column to users table.")
            except Exception:
                pass

            # Dynamically migrate circle_members custom member columns
            for member_col, col_type in [
                ("display_name", "VARCHAR(255)"),
                ("avatar_color", "VARCHAR(50)"),
                ("profile_picture_url", "VARCHAR(500)"),
                ("assigned_entity_id", "VARCHAR(255)")
            ]:
                try:
                    await conn.execute(text(f"ALTER TABLE circle_members ADD COLUMN {member_col} {col_type};"))
                    logger.info(f"Database migration: Added {member_col} column to circle_members table.")
                except Exception:
                    pass

            # Dynamically migrate sensor_registrations table if legacy schema without 'id' column exists
            try:
                table_info = await conn.execute(text("PRAGMA table_info(sensor_registrations);"))
                columns = table_info.fetchall()
                has_id_pk = any(col[1] == "id" and col[5] == 1 for col in columns)
                if columns and not has_id_pk:
                    logger.info("Migrating sensor_registrations table to device-scoped unique_id schema...")
                    await conn.execute(text("""
                        CREATE TABLE sensor_registrations_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            unique_id VARCHAR(255) NOT NULL,
                            entity_id VARCHAR(255) NOT NULL,
                            name VARCHAR(255) NOT NULL,
                            unit_of_measurement VARCHAR(50),
                            icon VARCHAR(100),
                            device_class VARCHAR(100),
                            state_class VARCHAR(100),
                            entity_category VARCHAR(100),
                            disabled BOOLEAN NOT NULL DEFAULT 0,
                            created_at DATETIME NOT NULL,
                            updated_at DATETIME NOT NULL,
                            CONSTRAINT uq_device_sensor_unique_id UNIQUE (device_id, unique_id)
                        );
                    """))
                    await conn.execute(text("""
                        INSERT INTO sensor_registrations_new (device_id, user_id, unique_id, entity_id, name, unit_of_measurement, icon, device_class, state_class, entity_category, disabled, created_at, updated_at)
                        SELECT device_id, user_id, unique_id, entity_id, name, unit_of_measurement, icon, device_class, state_class, entity_category, disabled, created_at, updated_at
                        FROM sensor_registrations;
                    """))
                    await conn.execute(text("DROP TABLE sensor_registrations;"))
                    await conn.execute(text("ALTER TABLE sensor_registrations_new RENAME TO sensor_registrations;"))
                    await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_device_sensor_unique_id ON sensor_registrations (device_id, unique_id);"))
                    await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_sensor_device_unique ON sensor_registrations (device_id, unique_id);"))
                    await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_sensor_user_device ON sensor_registrations (user_id, device_id);"))
                    logger.info("Successfully migrated sensor_registrations schema without data loss.")
            except Exception as e_mig:
                logger.warning(f"Note on sensor_registrations migration check: {e_mig}")
                
        logger.info("Database schemas created/verified successfully.")

        # Start background device offline checker
        import asyncio
        async def run_offline_checker():
            from app.db.database import async_session_maker
            from app.services.telemetry_service import TelemetryService
            logger.info("Background device offline checker task started.")
            while True:
                try:
                    async with async_session_maker() as session:
                        await TelemetryService.check_offline_devices(session)
                except Exception as ex:
                    logger.error(f"Error in offline devices checker task: {ex}")
                await asyncio.sleep(5) # Check frequently

        asyncio.create_task(run_offline_checker())

        # Start periodic expired token cleanup task
        async def run_token_cleaner():
            from app.db.database import async_session_maker
            from app.services.token_service import TokenService
            logger.info("Background token cleanup task started.")
            while True:
                try:
                    async with async_session_maker() as session:
                        await TokenService.cleanup_expired_tokens(session)
                except Exception as ex:
                    logger.error(f"Error in token cleanup task: {ex}")
                await asyncio.sleep(3600)

        asyncio.create_task(run_token_cleaner())

    except Exception as e:
        logger.critical(f"Database schema initialization failed: {e}")
        raise e

# Persistent uploads directory setup
uploads_path = settings.UPLOADS_DIR if settings.UPLOADS_DIR else os.path.join(os.getcwd(), "uploads")
profile_pics_path = os.path.join(uploads_path, "profile_pictures")
os.makedirs(profile_pics_path, exist_ok=True)

# Copy any legacy uploaded profile pictures into persistent directory on startup
legacy_path = os.path.join(os.getcwd(), "uploads", "profile_pictures")
if os.path.exists(legacy_path) and os.path.abspath(legacy_path) != os.path.abspath(profile_pics_path):
    try:
        import shutil
        for fname in os.listdir(legacy_path):
            src_f = os.path.join(legacy_path, fname)
            dst_f = os.path.join(profile_pics_path, fname)
            if os.path.isfile(src_f) and not os.path.exists(dst_f):
                shutil.copy2(src_f, dst_f)
                logger.info(f"Migrated legacy profile picture {fname} to persistent volume {profile_pics_path}")
    except Exception as e:
        logger.warning(f"Error migrating legacy profile pictures: {e}")

# Custom handler to serve /uploads files with primary persistent volume and legacy fallback
@app.get("/uploads/{file_path:path}")
async def serve_uploaded_file(file_path: str):
    safe_path = os.path.normpath(file_path).lstrip("/\\")
    if ".." in safe_path:
        return JSONResponse(status_code=400, content={"detail": "Invalid file path"})

    # Check primary persistent uploads directory
    primary_file = os.path.join(uploads_path, safe_path)
    if os.path.isfile(primary_file):
        return FileResponse(primary_file)

    # Fallback to legacy working directory uploads (e.g. /app/uploads/...)
    legacy_file = os.path.join(os.getcwd(), "uploads", safe_path)
    if os.path.isfile(legacy_file):
        try:
            os.makedirs(os.path.dirname(primary_file), exist_ok=True)
            import shutil
            shutil.copy2(legacy_file, primary_file)
        except Exception as e:
            logger.warning(f"Failed to auto-migrate legacy upload file {safe_path}: {e}")
        return FileResponse(primary_file if os.path.isfile(primary_file) else legacy_file)

    return JSONResponse(status_code=404, content={"detail": "File not found"})

# Register endpoint routers
app.include_router(auth.router)
app.include_router(rest.router)
app.include_router(mobile_app.router)
app.include_router(webhook.router)
app.include_router(websocket.router)
app.include_router(circles.router)
app.include_router(places.router)
app.include_router(alerts.router)
app.include_router(traccar.router)

# Serve the static compiled React app from dist/
dist_path = os.path.join(os.getcwd(), "dist")

@app.get("/{full_path:path}")
async def serve_static_or_spa(full_path: str):
    # Do not intercept API or uploads endpoints
    if full_path.startswith("api/") or full_path == "api" or full_path.startswith("uploads/") or full_path == "uploads":
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    
    if os.path.exists(dist_path):
        target_file = os.path.join(dist_path, full_path)
        if full_path and os.path.isfile(target_file):
            return FileResponse(target_file)
        index_file = os.path.join(dist_path, "index.html")
        if os.path.exists(index_file):
            return FileResponse(index_file, media_type="text/html")
            
    return JSONResponse(
        status_code=200,
        content={
            "status": "online",
            "message": "Home Assistant compatible server is running."
        }
    )
