import asyncio
import secrets
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Dict, Optional, Set, Union

# Type definition for event callback
EventCallback = Callable[[Dict[str, Any]], Union[None, Coroutine[Any, Any, None]]]


class EventBus:
    def __init__(self) -> None:
        self._listeners: Dict[str, Set[EventCallback]] = {}

    def subscribe(self, event_type: str, callback: EventCallback) -> Callable[[], None]:
        if event_type not in self._listeners:
            self._listeners[event_type] = set()
        self._listeners[event_type].add(callback)

        def unsubscribe() -> None:
            if event_type in self._listeners:
                self._listeners[event_type].discard(callback)
                if not self._listeners[event_type]:
                    del self._listeners[event_type]
        return unsubscribe

    async def fire(self, event_type: str, event_data: Dict[str, Any], user_id: Optional[int] = None) -> Dict[str, Any]:
        event_obj = {
            "event_type": event_type,
            "data": event_data,
            "origin": "LOCAL",
            "time_fired": datetime.now(timezone.utc).isoformat(),
            "context": {
                "id": secrets.token_hex(16),
                "user_id": user_id
            }
        }

        listeners = self._listeners.get(event_type, set()).copy()
        all_listeners = self._listeners.get("*", set()).copy()

        async def _notify(cb: EventCallback, ev: Dict[str, Any]) -> None:
            try:
                if asyncio.iscoroutinefunction(cb):
                    await cb(ev)
                else:
                    cb(ev)  # type: ignore
            except Exception:
                pass

        combined_listeners = listeners.union(all_listeners)
        if combined_listeners:
            await asyncio.gather(*[_notify(cb, event_obj) for cb in combined_listeners], return_exceptions=True)

        return event_obj

event_bus = EventBus()
