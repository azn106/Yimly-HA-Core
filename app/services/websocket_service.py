import asyncio
import time
import uuid
from typing import Any, Callable, Dict, Optional, Set
from fastapi import WebSocket
from starlette.websockets import WebSocketState
from app.core.logging import logger

class WebSocketSession:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.id: str = uuid.uuid4().hex[:8]
        self.connected_at: float = time.time()
        self.user_id: Optional[int] = None
        # Maps client-supplied subscription ID (int) -> unsubscribe callback function
        self.subscriptions: Dict[int, Callable[[], None]] = {}

    async def send_json(self, data: Dict[str, Any]) -> None:
        try:
            if self.websocket.client_state == WebSocketState.CONNECTED:
                await self.websocket.send_json(data)
        except Exception as e:
            logger.debug(f"Failed to send JSON to WebSocket: {e}")
            raise

class WebSocketSessionManager:
    def __init__(self) -> None:
        self.active_sessions: Set[WebSocketSession] = set()

    def connect(self, websocket: WebSocket) -> WebSocketSession:
        session = WebSocketSession(websocket)
        self.active_sessions.add(session)
        return session

    def disconnect(self, session: WebSocketSession) -> None:
        # Clean up all active subscriptions for this connection
        for sub_id, unsubscribe_func in list(session.subscriptions.items()):
            try:
                unsubscribe_func()
            except Exception:
                pass
        self.active_sessions.discard(session)

    async def broadcast_to_user(self, user_id: int, message: Dict[str, Any]) -> None:
        # Send only to connections owned by this specific user
        user_sessions = [s for s in self.active_sessions if s.user_id == user_id]
        if user_sessions:
            await asyncio.gather(*[s.send_json(message) for s in user_sessions], return_exceptions=True)

session_manager = WebSocketSessionManager()

