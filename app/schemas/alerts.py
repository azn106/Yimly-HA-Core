from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator

ALLOWED_ALERT_TYPES = ("arrival", "departure", "stop_sharing", "low_battery", "device_offline")
AlertType = Literal["arrival", "departure", "stop_sharing", "low_battery", "device_offline"]

class AlertCreate(BaseModel):
    circle_id: int
    user_id: int
    target_user_id: Optional[int] = None
    alert_type: AlertType
    title: str = Field(..., min_length=1, max_length=255)
    message: str = Field(..., min_length=1)

    @field_validator("alert_type")
    @classmethod
    def validate_alert_type(cls, v: str) -> str:
        if v not in ALLOWED_ALERT_TYPES:
            raise ValueError(f"Invalid alert_type. Must be one of: {', '.join(ALLOWED_ALERT_TYPES)}")
        return v

class AlertResponse(BaseModel):
    id: int
    circle_id: int
    user_id: int
    target_user_id: Optional[int] = None
    alert_type: AlertType
    title: str
    message: str
    read: bool
    created_at: datetime

    class Config:
        from_attributes = True

class AlertMarkReadResponse(BaseModel):
    id: int
    read: bool
    circle_id: int
    user_id: int
