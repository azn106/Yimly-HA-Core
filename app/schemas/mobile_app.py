from typing import Any, Dict, Optional
from pydantic import BaseModel, Field

class RegistrationRequest(BaseModel):
    device_id: str = Field(..., description="Unique device identifier")
    app_id: str = Field(..., description="Application identifier")
    app_name: str = Field(..., description="Application name")
    app_version: str = Field(..., description="Application version")
    device_name: str = Field(..., description="Readable name of the device")
    manufacturer: str = Field(..., description="Device manufacturer")
    model: str = Field(..., description="Device model")
    os_name: str = Field(..., description="Operating system name")
    os_version: str = Field(..., description="Operating system version")
    supports_encryption: bool = Field(default=False, description="Whether the app supports encryption")
    app_data: Optional[Dict[str, Any]] = Field(default=None, description="App specific extra data")

class RegistrationResponse(BaseModel):
    webhook_id: str = Field(..., description="Unique, unpredictable webhook endpoint ID")
    secret: Optional[str] = Field(default=None, description="Cryptographically secure secret key if encryption is requested")
    cloudhook_url: Optional[str] = Field(default=None, description="Optional cloudhook proxy URL if supported")
    remote_ui_url: Optional[str] = Field(default=None, description="Optional remote gateway URL if supported")
