from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field, field_validator

class PlaceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Name of the place")
    address: Optional[str] = Field(None, max_length=500, description="Optional street address")
    latitude: float = Field(..., description="Latitude between -90 and 90")
    longitude: float = Field(..., description="Longitude between -180 and 180")
    radius: float = Field(100.0, description="Geofence radius in meters")
    icon: Optional[str] = Field(None, max_length=100, description="Optional icon identifier")

    @field_validator("latitude")
    @classmethod
    def validate_latitude(cls, v: float) -> float:
        if not (-90.0 <= v <= 90.0):
            raise ValueError("Latitude must be between -90 and 90 degrees.")
        return v

    @field_validator("longitude")
    @classmethod
    def validate_longitude(cls, v: float) -> float:
        if not (-180.0 <= v <= 180.0):
            raise ValueError("Longitude must be between -180 and 180 degrees.")
        return v

    @field_validator("radius")
    @classmethod
    def validate_radius(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Radius must be greater than 0 meters.")
        if v > 100000:
            raise ValueError("Radius cannot exceed 100,000 meters.")
        return v

class PlaceUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    address: Optional[str] = Field(None, max_length=500)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    radius: Optional[float] = None
    icon: Optional[str] = Field(None, max_length=100)

    @field_validator("latitude")
    @classmethod
    def validate_latitude(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (-90.0 <= v <= 90.0):
            raise ValueError("Latitude must be between -90 and 90 degrees.")
        return v

    @field_validator("longitude")
    @classmethod
    def validate_longitude(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (-180.0 <= v <= 180.0):
            raise ValueError("Longitude must be between -180 and 180 degrees.")
        return v

    @field_validator("radius")
    @classmethod
    def validate_radius(cls, v: Optional[float]) -> Optional[float]:
        if v is not None:
            if v <= 0:
                raise ValueError("Radius must be greater than 0 meters.")
            if v > 100000:
                raise ValueError("Radius cannot exceed 100,000 meters.")
        return v

class PlaceResponse(BaseModel):
    id: int
    circle_id: int
    name: str
    address: Optional[str] = None
    latitude: float
    longitude: float
    radius: float
    icon: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
