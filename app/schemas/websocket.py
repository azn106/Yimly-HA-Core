from typing import Any, Dict, Optional, Union
from pydantic import BaseModel, Field

class WSAuthMessage(BaseModel):
    type: str = "auth"
    access_token: str

class WSCommand(BaseModel):
    id: int = Field(..., description="Unique sequence ID for the command")
    type: str = Field(..., description="WebSocket command type")

    class Config:
        extra = "allow"

class WSResponse(BaseModel):
    id: Optional[int] = None
    type: str = "result"
    success: bool = True
    result: Optional[Any] = None
    error: Optional[Dict[str, Any]] = None
