from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field, field_validator, model_validator

class LocationUpdateData(BaseModel):
    latitude: Optional[float] = Field(default=None, description="Latitude coordinate")
    longitude: Optional[float] = Field(default=None, description="Longitude coordinate")
    gps: Optional[List[float]] = Field(default=None, description="HA GPS coordinate pair [lat, lon]")
    gps_accuracy: Optional[float] = Field(default=None, description="GPS accuracy radius in meters")
    accuracy: Optional[float] = Field(default=None, description="HA accuracy alias")
    altitude: Optional[float] = Field(default=None, description="Altitude in meters")
    speed: Optional[float] = Field(default=None, description="Speed in meters per second")
    bearing: Optional[float] = Field(default=None, description="Bearing/heading in degrees")
    course: Optional[float] = Field(default=None, description="HA course alias for bearing")
    battery: Optional[float] = Field(default=None, description="Battery level percentage")
    trigger: Optional[str] = Field(default=None, description="What triggered the location update")
    vertical_accuracy: Optional[float] = Field(default=None, description="Vertical accuracy in meters")
    location_name: Optional[str] = Field(default=None, description="Optional HA zone/location name")
    zone: Optional[str] = Field(default=None, description="Optional HA zone name alias")

    class Config:
        extra = "allow"

    @model_validator(mode="before")
    @classmethod
    def parse_ha_payload(cls, data: Any) -> Any:
        if isinstance(data, dict):
            # 1. Unnest from "location" if present (iOS nested location struct)
            if "location" in data and isinstance(data["location"], dict):
                loc = data.pop("location")
                for k, v in loc.items():
                    if k not in data or data[k] is None:
                        data[k] = v

            # 2. Parse HA "gps": [lat, lon]
            if "gps" in data and isinstance(data["gps"], (list, tuple)) and len(data["gps"]) >= 2:
                if "latitude" not in data or data["latitude"] is None:
                    try:
                        data["latitude"] = float(data["gps"][0])
                    except (ValueError, TypeError):
                        pass
                if "longitude" not in data or data["longitude"] is None:
                    try:
                        data["longitude"] = float(data["gps"][1])
                    except (ValueError, TypeError):
                        pass

            # 3. Parse HA "accuracy" -> "gps_accuracy"
            if "accuracy" in data and ("gps_accuracy" not in data or data["gps_accuracy"] is None):
                data["gps_accuracy"] = data["accuracy"]

            # 4. Parse HA "course" -> "bearing"
            if "course" in data and ("bearing" not in data or data["bearing"] is None):
                data["bearing"] = data["course"]

            # 5. Parse HA "zone" -> "location_name"
            if "zone" in data and ("location_name" not in data or data["location_name"] is None):
                data["location_name"] = str(data["zone"])
        return data

    @field_validator("latitude")
    @classmethod
    def validate_latitude(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (-90.0 <= v <= 90.0):
            raise ValueError("Latitude must be between -90 and 90")
        return v

    @field_validator("longitude")
    @classmethod
    def validate_longitude(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (-180.0 <= v <= 180.0):
            raise ValueError("Longitude must be between -180 and 180")
        return v

class SensorRegistrationData(BaseModel):
    unique_id: str = Field(..., description="Unique ID for the sensor")
    name: str = Field(..., description="Readable name of the sensor")
    type: Optional[str] = Field(default="sensor", description="Type of entity: sensor, binary_sensor, etc.")
    state: Optional[Any] = Field(default=None, description="Initial state of the sensor")
    attributes: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Initial sensor attributes")
    unit_of_measurement: Optional[str] = Field(default=None, description="Unit of measurement")
    icon: Optional[str] = Field(default=None, description="Lucide or MDI icon")
    device_class: Optional[str] = Field(default=None, description="HA device class classification")
    state_class: Optional[str] = Field(default=None, description="HA state class")
    entity_category: Optional[str] = Field(default=None, description="HA entity category")
    disabled: Optional[bool] = Field(default=False, description="Whether the sensor is disabled")

    class Config:
        extra = "allow"

    @model_validator(mode="before")
    @classmethod
    def normalize_sensor_data(cls, data: Any) -> Any:
        if isinstance(data, dict):
            if not data.get("type"):
                data["type"] = "sensor"
        return data

class SensorStateUpdate(BaseModel):
    unique_id: str = Field(..., description="Unique ID of the registered sensor")
    state: Optional[Any] = Field(default=None, description="The new state/value of the sensor")
    attributes: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Attributes for the sensor state")
    type: Optional[str] = Field(default=None, description="Optional entity type")
    icon: Optional[str] = Field(default=None, description="Optional sensor icon")

    class Config:
        extra = "allow"

class WebhookRequest(BaseModel):
    type: str = Field(..., description="Type of webhook payload: update_location, register_sensor, update_sensor_states, get_zones, get_config, etc.")
    data: Optional[Union[LocationUpdateData, SensorRegistrationData, List[SensorStateUpdate], Dict[str, Any]]] = Field(default=None, description="Payload data")
