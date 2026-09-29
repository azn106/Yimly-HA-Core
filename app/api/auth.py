import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import APIRouter, Depends, Form, HTTPException, Request, status, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.core.config import settings
from app.core.logging import logger
from app.core.security import create_jwt_token
from app.db.database import get_db
from app.db.models import User
from app.schemas.auth import UserCreate, UserResponse, ProfileUpdate
from app.services.auth_service import AuthService
from app.services.token_service import TokenService

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")


class LoginRequest(BaseModel):
    username: str
    password: str


@router.get("/auth/authorize", response_class=HTMLResponse)
async def authorize_get(
    request: Request,
    client_id: Optional[str] = "https://home-assistant.io/android",
    redirect_uri: Optional[str] = "homeassistant://auth-callback",
    response_type: Optional[str] = "code",
    state: Optional[str] = None,
    scope: Optional[str] = None
) -> HTMLResponse:
    # Render login form preserving original state parameters
    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={
            "client_id": client_id or "https://home-assistant.io/android",
            "redirect_uri": redirect_uri or "homeassistant://auth-callback",
            "response_type": response_type or "code",
            "state": state or "",
            "error": None
        }
    )


@router.post("/auth/login_submit")
async def authorize_post(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    client_id: Optional[str] = Form("https://home-assistant.io/android"),
    redirect_uri: Optional[str] = Form("homeassistant://auth-callback"),
    response_type: Optional[str] = Form("code"),
    state: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db)
):
    actual_client_id = client_id or "https://home-assistant.io/android"
    actual_redirect_uri = redirect_uri or "homeassistant://auth-callback"
    actual_response_type = response_type or "code"

    # Authenticate credentials
    user = await AuthService.authenticate_user(db, username, password)
    if not user:
        # Re-render with failure message
        return templates.TemplateResponse(
            request=request,
            name="login.html",
            context={
                "client_id": actual_client_id,
                "redirect_uri": actual_redirect_uri,
                "response_type": actual_response_type,
                "state": state or "",
                "error": "Invalid username or password"
            }
        )

    # Handshake success: Generate temporary single-use Auth Code
    try:
        code = await TokenService.create_authorization_code(
            db=db,
            user_id=user.id,
            client_id=actual_client_id,
            redirect_uri=actual_redirect_uri
        )
    except Exception as e:
        logger.error(f"Failed to generate auth code: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

    # Redirect client/webview to the provided Redirect URI with parameters
    separator = "&" if "?" in actual_redirect_uri else "?"
    redirect_url = f"{actual_redirect_uri}{separator}code={code}"

    if state:
        redirect_url += f"&state={state}"

    logger.info(f"User {user.username} authenticated successfully. Redirecting to mobile-app callback.")
    return RedirectResponse(url=redirect_url, status_code=status.HTTP_302_FOUND)


@router.post("/auth/token")
async def exchange_token(
    grant_type: Optional[str] = Form(None),
    client_id: Optional[str] = Form(None),
    code: Optional[str] = Form(None),
    redirect_uri: Optional[str] = Form(None),
    refresh_token: Optional[str] = Form(None),
    token: Optional[str] = Form(None),
    action: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db)
):
    # Support Home Assistant token revocation action
    if action == "revoke" or grant_type == "revoke":
        target_token = token or refresh_token or code
        if target_token:
            await TokenService.revoke_token(db=db, raw_token=target_token, client_id=client_id)
        return {}

    if not grant_type:
        raise HTTPException(
            status_code=400,
            detail="grant_type is required."
        )

    if not client_id:
        raise HTTPException(
            status_code=400,
            detail="client_id is required."
        )

    if grant_type == "authorization_code":
        if not code:
            raise HTTPException(
                status_code=400,
                detail="Code is required for authorization_code grant."
            )

        # Validate code atomically (redirect_uri verified if provided)
        user_id = await TokenService.redeem_authorization_code(
            db=db,
            raw_code=code,
            client_id=client_id,
            redirect_uri=redirect_uri
        )
        if user_id is None:
            raise HTTPException(
                status_code=400,
                detail="Invalid, expired, or already used authorization code."
            )

        # Create JWT Access Token and Refresh Token
        access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        access_token = create_jwt_token(
            data={"sub": str(user_id), "typ": "access"},
            expires_delta=access_token_expires
        )

        # Create persistent Refresh Token
        new_refresh_token = await TokenService.create_refresh_token(
            db=db,
            user_id=user_id,
            client_id=client_id
        )

        logger.info(f"Successfully issued access token and refresh token for user {user_id}")
        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": int(access_token_expires.total_seconds()),
            "refresh_token": new_refresh_token
        }

    elif grant_type == "refresh_token":
        if not refresh_token:
            raise HTTPException(
                status_code=400,
                detail="refresh_token is required for refresh_token grant."
            )

        user_id = await TokenService.redeem_refresh_token(
            db=db,
            raw_token=refresh_token,
            client_id=client_id
        )
        if user_id is None:
            raise HTTPException(
                status_code=400,
                detail="Invalid, revoked, or expired refresh token."
            )

        # Issue new Access Token (keep old refresh token active)
        access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        access_token = create_jwt_token(
            data={"sub": str(user_id), "typ": "access"},
            expires_delta=access_token_expires
        )

        logger.info(f"Successfully refreshed access token for user {user_id}")
        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": int(access_token_expires.total_seconds()),
            "refresh_token": refresh_token
        }

    else:
        raise HTTPException(status_code=400, detail="Unsupported grant_type.")


@router.post("/auth/revoke")
async def revoke_auth_token(
    request: Request,
    token: Optional[str] = Form(None),
    token_type_hint: Optional[str] = Form(None),
    client_id: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db)
):
    """RFC 7009 OAuth 2.0 Token Revocation endpoint."""
    raw_token = token
    # Also support JSON payload if client sends application/json
    if not raw_token:
        try:
            body = await request.json()
            if isinstance(body, dict):
                raw_token = body.get("token") or body.get("refresh_token")
                client_id = client_id or body.get("client_id")
        except Exception:
            pass

    if raw_token:
        await TokenService.revoke_token(db=db, raw_token=raw_token, client_id=client_id)

    return {}


class LogoutRequest(BaseModel):
    refresh_token: Optional[str] = None


@router.post("/api/auth/logout")
async def api_logout(
    request: Request,
    logout_in: Optional[LogoutRequest] = None,
    db: AsyncSession = Depends(get_db)
):
    """Web & REST logout endpoint: revokes active access token and refresh token."""
    # Revoke current Bearer access token if provided in header
    auth_header = request.headers.get("authorization")
    if auth_header and auth_header.startswith("Bearer "):
        bearer_token = auth_header.split(" ", 1)[1].strip()
        if bearer_token:
            await TokenService.revoke_token(db=db, raw_token=bearer_token)

    # Revoke refresh token if provided in body
    if logout_in and logout_in.refresh_token:
        await TokenService.revoke_token(db=db, raw_token=logout_in.refresh_token)

    return {"success": True, "message": "Logged out successfully"}


@router.get("/api/setup/status")
async def get_setup_status(db: AsyncSession = Depends(get_db)):
    # Check if any user exists in the database
    stmt = select(func.count()).select_from(User)
    result = await db.execute(stmt)
    count = result.scalar()
    return {"needs_setup": count == 0}


@router.post("/api/setup/register", response_model=UserResponse)
async def setup_register(user_in: UserCreate, db: AsyncSession = Depends(get_db)):
    # Verify setup is actually needed (no users in db)
    stmt = select(func.count()).select_from(User)
    result = await db.execute(stmt)
    count = result.scalar()

    if count > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Setup has already been completed."
        )

    # Check if username already exists
    existing = await AuthService.get_user_by_username(db, user_in.username)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already exists."
        )

    user = await AuthService.create_user(db, user_in)
    return user


@router.post("/api/auth/register", response_model=UserResponse)
async def api_register(user_in: UserCreate, db: AsyncSession = Depends(get_db)):
    # Verify setup is NOT needed (at least one user exists in the db)
    stmt = select(func.count()).select_from(User)
    result = await db.execute(stmt)
    count = result.scalar()

    if count == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="First-run setup has not been completed yet."
        )

    # Check if username already exists
    existing = await AuthService.get_user_by_username(db, user_in.username)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already exists."
        )

    user = await AuthService.create_user(db, user_in)
    return user


@router.post("/api/auth/login")
async def api_login(login_in: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = await AuthService.authenticate_user(db, login_in.username, login_in.password)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )

    # Generate JWT Access Token and Refresh Token
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_jwt_token(
        data={"sub": str(user.id), "typ": "access"},
        expires_delta=access_token_expires
    )

    new_refresh_token = await TokenService.create_refresh_token(
        db=db,
        user_id=user.id,
        client_id="web_ui"
    )

    return {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": int(access_token_expires.total_seconds()),
        "refresh_token": new_refresh_token,
        "user": {
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "avatar_color": user.avatar_color,
            "profile_picture_url": user.profile_picture_url,
            "map_style": user.map_style or "osm",
            "map_selected_icon_size": user.map_selected_icon_size or 72,
            "map_unselected_icon_size": user.map_unselected_icon_size or 64,
            "share_location": user.share_location if user.share_location is not None else True,
            "save_location_history": user.save_location_history if user.save_location_history is not None else True,
            "history_retention": user.history_retention or "30d",
            "location_update_frequency": user.location_update_frequency or "realtime",
            "notify_push": user.notify_push if user.notify_push is not None else True,
            "notify_arrival_departure": user.notify_arrival_departure if user.notify_arrival_departure is not None else True,
            "notify_stop_sharing": user.notify_stop_sharing if user.notify_stop_sharing is not None else True,
            "notify_low_battery": user.notify_low_battery if user.notify_low_battery is not None else True,
            "notify_device_offline": user.notify_device_offline if user.notify_device_offline is not None else True
        }
    }


from app.api.deps import require_authenticated_user
from app.services.telemetry_service import cleanup_history_for_user


@router.get("/api/auth/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(require_authenticated_user)):
    return current_user


@router.put("/api/auth/profile", response_model=UserResponse)
async def update_profile(
    profile_in: ProfileUpdate,
    current_user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    previous_share = current_user.share_location if current_user.share_location is not None else True
    is_stop_sharing_transition = False

    if profile_in.avatar_color is not None:
        current_user.avatar_color = profile_in.avatar_color

    if profile_in.display_name is not None:
        current_user.display_name = profile_in.display_name

    if profile_in.share_location is not None:
        next_share = bool(profile_in.share_location)
        if previous_share is True and next_share is False:
            is_stop_sharing_transition = True
        current_user.share_location = next_share

    if profile_in.save_location_history is not None:
        current_user.save_location_history = bool(profile_in.save_location_history)

    if profile_in.history_retention is not None:
        allowed_retentions = {"7d", "30d", "90d", "1y", "forever"}

        if profile_in.history_retention in allowed_retentions:
            current_user.history_retention = profile_in.history_retention
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid history_retention value. Must be one of {allowed_retentions}"
            )

    if profile_in.location_update_frequency is not None:
        allowed_frequencies = {"realtime", "1m", "5m", "15m"}

        if profile_in.location_update_frequency in allowed_frequencies:
            current_user.location_update_frequency = profile_in.location_update_frequency
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid location_update_frequency value. Must be one of {allowed_frequencies}"
            )

    if profile_in.notify_push is not None:
        current_user.notify_push = bool(profile_in.notify_push)

    if profile_in.notify_arrival_departure is not None:
        current_user.notify_arrival_departure = bool(profile_in.notify_arrival_departure)

    if profile_in.notify_stop_sharing is not None:
        current_user.notify_stop_sharing = bool(profile_in.notify_stop_sharing)

    if profile_in.notify_low_battery is not None:
        current_user.notify_low_battery = bool(profile_in.notify_low_battery)

    if profile_in.notify_device_offline is not None:
        current_user.notify_device_offline = bool(profile_in.notify_device_offline)

    if profile_in.map_style is not None:
        allowed_styles = {
            "osm",
            "openfree_positron",
            "openfree_bright",
            "openfree_liberty",
            "openfree_dark",
            "openfree_fiord",
            "carto_voyager",
            "carto_positron",
            "carto_dark"
        }

        if profile_in.map_style in allowed_styles:
            current_user.map_style = profile_in.map_style
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid map_style value. Must be one of {allowed_styles}"
            )

    if profile_in.map_selected_icon_size is not None:
        if 24 <= profile_in.map_selected_icon_size <= 72:
            current_user.map_selected_icon_size = profile_in.map_selected_icon_size
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="map_selected_icon_size must be between 24 and 72 pixels."
            )

    if profile_in.map_unselected_icon_size is not None:
        if 24 <= profile_in.map_unselected_icon_size <= 72:
            current_user.map_unselected_icon_size = profile_in.map_unselected_icon_size
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="map_unselected_icon_size must be between 24 and 72 pixels."
            )

    db.add(current_user)
    await db.commit()
    await db.refresh(current_user)

    if is_stop_sharing_transition:
        from app.db.models import CircleMember, User as UserModel
        from app.schemas.alerts import AlertCreate
        from app.services.alert_service import AlertService

        stmt_circle = select(CircleMember.circle_id).where(
            CircleMember.user_id == current_user.id
        )
        res_circle = await db.execute(stmt_circle)
        circle_ids = res_circle.scalars().all()

        for circle_id in circle_ids:
            stmt_members = select(UserModel).join(CircleMember).where(
                CircleMember.circle_id == circle_id
            )
            res_members = await db.execute(stmt_members)
            members = res_members.scalars().all()

            for m in members:
                if m.id == current_user.id:
                    continue

                if getattr(m, "notify_stop_sharing", True) is False:
                    continue

                title = f"{current_user.display_name} stopped sharing location"
                message = (
                    f"{current_user.display_name} has stopped sharing "
                    f"their location with the circle."
                )

                await AlertService.create_alert(
                    db=db,
                    alert_in=AlertCreate(
                        circle_id=circle_id,
                        user_id=m.id,
                        target_user_id=current_user.id,
                        alert_type="stop_sharing",
                        title=title,
                        message=message
                    )
                )

    if profile_in.history_retention is not None:
        await cleanup_history_for_user(
            db,
            current_user.id,
            current_user.history_retention
        )

    return current_user


def get_profile_pictures_dir() -> str:
    base_uploads = settings.UPLOADS_DIR if settings.UPLOADS_DIR else os.path.join(os.getcwd(), "uploads")
    profile_pics_dir = os.path.join(base_uploads, "profile_pictures")
    os.makedirs(profile_pics_dir, exist_ok=True)
    return profile_pics_dir


@router.post("/api/auth/profile/picture", response_model=UserResponse)
@router.post("/api/auth/profile-picture", response_model=UserResponse)
async def upload_profile_picture(
    file: UploadFile = File(...),
    current_user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    allowed_types = ["image/jpeg", "image/jpg", "image/png", "image/webp"]
    allowed_exts = [".jpg", ".jpeg", ".png", ".webp"]

    filename_lower = file.filename.lower() if file.filename else ""
    ext = os.path.splitext(filename_lower)[1]

    if ext not in allowed_exts or (
        file.content_type
        and file.content_type.lower() not in allowed_types
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid file type. Only JPEG, PNG, and WebP images are allowed."
        )

    contents = await file.read()

    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File size exceeds maximum limit of 5MB."
        )

    # Basic magic bytes check
    is_valid_magic = (
        contents.startswith(b"\xff\xd8\xff")
        or contents.startswith(b"\x89PNG\r\n\x1a\n")
        or (
            contents.startswith(b"RIFF")
            and b"WEBP" in contents[:16]
        )
    )

    if not is_valid_magic:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Corrupted or invalid image file content."
        )

    # Remove existing photo if present across both persistent and legacy paths
    if current_user.profile_picture_url:
        old_file_name = os.path.basename(current_user.profile_picture_url)
        for check_dir in [get_profile_pictures_dir(), os.path.join(os.getcwd(), "uploads", "profile_pictures")]:
            old_file_path = os.path.join(check_dir, old_file_name)
            if os.path.exists(old_file_path):
                try:
                    os.remove(old_file_path)
                except Exception as e:
                    logger.warning(
                        f"Failed to delete old profile picture "
                        f"{old_file_path}: {e}"
                    )

    # Generate safe server-side filename
    safe_ext = ext if ext in allowed_exts else ".jpg"
    unique_filename = (
        f"user_{current_user.id}_"
        f"{int(datetime.now(timezone.utc).timestamp())}_"
        f"{uuid.uuid4().hex[:8]}{safe_ext}"
    )

    upload_dir = get_profile_pictures_dir()
    target_path = os.path.join(upload_dir, unique_filename)

    with open(target_path, "wb") as f:
        f.write(contents)

    picture_url = f"/uploads/profile_pictures/{unique_filename}"
    current_user.profile_picture_url = picture_url

    db.add(current_user)
    await db.commit()
    await db.refresh(current_user)

    return current_user


@router.delete("/api/auth/profile/picture", response_model=UserResponse)
@router.delete("/api/auth/profile-picture", response_model=UserResponse)
async def delete_profile_picture(
    current_user: User = Depends(require_authenticated_user),
    db: AsyncSession = Depends(get_db)
):
    if current_user.profile_picture_url:
        old_file_name = os.path.basename(current_user.profile_picture_url)
        for check_dir in [get_profile_pictures_dir(), os.path.join(os.getcwd(), "uploads", "profile_pictures")]:
            old_file_path = os.path.join(check_dir, old_file_name)
            if os.path.exists(old_file_path):
                try:
                    os.remove(old_file_path)
                except Exception as e:
                    logger.warning(
                        f"Failed to delete old profile picture "
                        f"{old_file_path}: {e}"
                    )

        current_user.profile_picture_url = None

        db.add(current_user)
        await db.commit()
        await db.refresh(current_user)

    return current_user