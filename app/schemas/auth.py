from typing import Optional
from pydantic import BaseModel, Field

class UserCreate(BaseModel):
    username: str = Field(..., description="Unique email or username")
    password: str = Field(..., min_length=6, description="Secure password")
    display_name: str = Field(..., description="User's display name")

class UserResponse(BaseModel):
    id: int
    username: str
    display_name: str
    avatar_color: Optional[str] = None
    profile_picture_url: Optional[str] = None
    map_style: Optional[str] = "osm"
    map_selected_icon_size: Optional[int] = 72
    map_unselected_icon_size: Optional[int] = 64
    share_location: bool = True
    save_location_history: bool = True
    history_retention: str = "30d"
    location_update_frequency: str = "realtime"
    notify_push: bool = True
    notify_arrival_departure: bool = True
    notify_stop_sharing: bool = True
    notify_low_battery: bool = True
    notify_device_offline: bool = True
    is_active: bool

    class Config:
        from_attributes = True

class ProfileUpdate(BaseModel):
    avatar_color: Optional[str] = None
    display_name: Optional[str] = None
    map_style: Optional[str] = None
    map_selected_icon_size: Optional[int] = Field(None, ge=24, le=72, description="Selected member map icon size (24-72 px)")
    map_unselected_icon_size: Optional[int] = Field(None, ge=24, le=72, description="Unselected member map icon size (24-72 px)")
    share_location: Optional[bool] = None
    save_location_history: Optional[bool] = None
    history_retention: Optional[str] = None
    location_update_frequency: Optional[str] = None
    notify_push: Optional[bool] = None
    notify_arrival_departure: Optional[bool] = None
    notify_stop_sharing: Optional[bool] = None
    notify_low_battery: Optional[bool] = None
    notify_device_offline: Optional[bool] = None

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    refresh_token: Optional[str] = None
