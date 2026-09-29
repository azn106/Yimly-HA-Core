from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field

class UnitSystem(BaseModel):
    length: str = "km"
    mass: str = "g"
    pressure: str = "Pa"
    temperature: str = "°C"
    volume: str = "L"

class ConfigResponse(BaseModel):
    components: List[str] = Field(default_factory=list)
    config_dir: str = "/config"
    elevation: int = 0
    latitude: float = 0.0
    location_name: str = "Home Assistant compatible server"
    longitude: float = 0.0
    time_zone: str = "UTC"
    unit_system: UnitSystem = Field(default_factory=UnitSystem)
    version: str = "2026.9.1"  # Matches a modern Home Assistant core version
    whitelist_external_dirs: List[str] = Field(default_factory=list)

class EntityStateResponse(BaseModel):
    entity_id: str
    state: str
    attributes: Dict[str, Any]
    last_changed: str
    last_updated: str
    context: Dict[str, Any] = Field(default_factory=dict)
