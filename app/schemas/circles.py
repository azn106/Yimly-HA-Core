from pydantic import BaseModel, Field
from datetime import datetime
from typing import List, Optional, Any, Dict

class CircleCreate(BaseModel):
    name: str = Field(..., description="Name of the Circle")

class CircleJoin(BaseModel):
    invite_code: str = Field(..., description="Invitation code for the Circle")

class CircleResponse(BaseModel):
    id: int
    name: str
    owner_id: int
    invite_code: str
    created_at: datetime

    class Config:
        from_attributes = True

class MemberDeviceLocation(BaseModel):
    entity_id: str
    device_name: str
    latitude: float
    longitude: float
    battery: Optional[Any] = None
    charging: Optional[bool] = None
    accuracy: Optional[float] = None
    last_updated: str
    map_icon: Optional[str] = None
    location_visibility: Optional[str] = None
    is_default: Optional[bool] = False

class MemberResponse(BaseModel):
    id: int
    username: str
    display_name: str
    avatar_color: Optional[str] = None
    profile_picture_url: Optional[str] = None
    assigned_entity_id: Optional[str] = None
    is_owner: Optional[bool] = False
    devices: List[MemberDeviceLocation] = []

    class Config:
        from_attributes = True

class MemberCreate(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=255, description="Display name of the family member")
    avatar_color: Optional[str] = Field(None, description="Hex color for the member avatar")
    profile_picture_url: Optional[str] = Field(None, description="Profile picture URL")
    assigned_entity_id: Optional[str] = Field(None, description="Assigned Home Assistant device_tracker entity ID")

class MemberUpdate(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=255)
    avatar_color: Optional[str] = None
    profile_picture_url: Optional[str] = None
    assigned_entity_id: Optional[str] = None

class HADeviceResponse(BaseModel):
    entity_id: str
    device_name: str
    state: str
    is_available: bool = True
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy: Optional[float] = None
    battery: Optional[float] = None
    charging: Optional[bool] = None
    platform: Optional[str] = None
    last_updated: Optional[str] = None
    map_icon: Optional[str] = None
