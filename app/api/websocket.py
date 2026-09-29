import asyncio
from typing import Any, Dict, Optional
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from app.core.logging import logger
from app.core.security import verify_jwt_token
from app.db.database import async_session_maker
from app.db.models import User
from app.services.event_service import event_bus
from app.services.state_service import StateService
from app.services.token_service import TokenService
from app.services.websocket_service import session_manager

router = APIRouter()

async def session_keepalive(session: Any) -> None:
    """Sends periodic keepalive pings to prevent proxy/NAT/Cloud Run 60s idle disconnects."""
    try:
        while True:
            await asyncio.sleep(25)
            try:
                await session.send_json({"type": "ping"})
            except Exception:
                break
    except asyncio.CancelledError:
        pass

@router.websocket("/api/websocket")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session = session_manager.connect(websocket)
    logger.info("New WebSocket client connected. Initiating Home Assistant handshake.")

    # 1. Send auth_required challenge
    await session.send_json({
        "type": "auth_required",
        "ha_version": "2026.9.1"
    })

    # 2. Wait for auth response
    try:
        auth_msg = await websocket.receive_json()
        if not isinstance(auth_msg, dict) or auth_msg.get("type") != "auth":
            await session.send_json({
                "type": "auth_invalid",
                "message": "Auth message required"
            })
            await websocket.close()
            session_manager.disconnect(session)
            return

        token = auth_msg.get("access_token")
        payload = verify_jwt_token(token or "")
        if not payload:
            await session.send_json({
                "type": "auth_invalid",
                "message": "Invalid access token"
            })
            await websocket.close()
            session_manager.disconnect(session)
            return

        # Check if access token was revoked
        jti = payload.get("jti")
        token_hash = TokenService.hash_value(token or "")
        async with async_session_maker() as db:
            if await TokenService.is_token_revoked(db, jti=jti, token_hash=token_hash):
                await session.send_json({
                    "type": "auth_invalid",
                    "message": "Access token has been revoked"
                })
                await websocket.close()
                session_manager.disconnect(session)
                return

        # Authenticate user
        user_id_str = payload.get("sub")
        if not user_id_str:
            await session.send_json({
                "type": "auth_invalid",
                "message": "Malformed token sub claim"
            })
            await websocket.close()
            session_manager.disconnect(session)
            return

        user_id = int(user_id_str)
        async with async_session_maker() as db:
            stmt = select(User).where(User.id == user_id, User.is_active == True)
            res = await db.execute(stmt)
            user = res.scalar_one_or_none()

        if not user:
            await session.send_json({
                "type": "auth_invalid",
                "message": "User not found or deactivated"
            })
            await websocket.close()
            session_manager.disconnect(session)
            return

        # Handshake success!
        session.user_id = user_id
        await session.send_json({
            "type": "auth_ok",
            "ha_version": "2026.9.1"
        })
        logger.info(f"WebSocket client authenticated successfully for user {user.username} (ID: {user.id})")

    except Exception as e:
        logger.error(f"WebSocket auth handshake failed: {e}")
        try:
            await websocket.close()
        except Exception:
            pass
        session_manager.disconnect(session)
        return

    # Start keepalive heartbeat task
    keepalive_task = asyncio.create_task(session_keepalive(session))

    # 3. Handle commands loop
    try:
        while True:
            msg = await websocket.receive_json()
            if not isinstance(msg, dict):
                continue

            cmd_id = msg.get("id")
            cmd_type = msg.get("type")

            if cmd_type == "pong":
                continue

            if cmd_type == "ping" and cmd_id is None:
                await session.send_json({"type": "pong"})
                continue

            if not isinstance(cmd_id, int) or not cmd_type:
                await session.send_json({
                    "type": "result",
                    "success": False,
                    "error": {"code": "invalid_format", "message": "Message ID (int) and type are required."}
                })
                continue

            try:
                await handle_command(session, cmd_id, cmd_type, msg)
            except Exception as cmd_err:
                logger.error(f"Error handling WebSocket command '{cmd_type}' (id: {cmd_id}): {cmd_err}")
                await session.send_json({
                    "id": cmd_id,
                    "type": "result",
                    "success": False,
                    "error": {"code": "internal_error", "message": f"Error executing command '{cmd_type}'."}
                })

    except WebSocketDisconnect as e:
        logger.info(f"[WS-DIAG] Server WebSocket disconnected for user {session.user_id} (code={getattr(e, 'code', None)}, reason={getattr(e, 'reason', None)})")
    except Exception as e:
        logger.error(f"[WS-DIAG] Server WebSocket processing loop error for user {session.user_id}: {e}")
    finally:
        keepalive_task.cancel()
        session_manager.disconnect(session)

async def handle_command(session: Any, cmd_id: int, cmd_type: str, msg: Dict[str, Any]) -> None:
    user_id = session.user_id

    if cmd_type == "auth/current_user":
        async with async_session_maker() as db:
            stmt = select(User).where(User.id == user_id)
            res = await db.execute(stmt)
            u = res.scalar_one_or_none()
            user_name = (u.display_name or u.username) if u else f"User {user_id}"
            user_id_str = str(u.id) if u else str(user_id)

        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": {
                "id": user_id_str,
                "name": user_name,
                "is_owner": True,
                "is_admin": True,
                "credentials": [],
                "mfa_modules": []
            }
        })

    elif cmd_type == "ping":
        await session.send_json({
            "id": cmd_id,
            "type": "pong"
        })

    elif cmd_type == "supported_features":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": None
        })

    elif cmd_type == "get_states":
        async with async_session_maker() as db:
            entities = await StateService.get_all_states(db, user_id)
            states_list = [
                {
                    "entity_id": e.entity_id,
                    "state": e.state,
                    "attributes": e.attributes,
                    "last_changed": e.last_changed.isoformat(),
                    "last_updated": e.last_updated.isoformat(),
                    "context": {"id": f"ctx_{e.entity_id}", "user_id": str(user_id)}
                }
                for e in entities
            ]
            await session.send_json({
                "id": cmd_id,
                "type": "result",
                "success": True,
                "result": states_list
            })

    elif cmd_type == "get_config":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": {
                "latitude": 0.0,
                "longitude": 0.0,
                "elevation": 0,
                "unit_system": {"length": "km", "mass": "g", "temperature": "°C", "volume": "L"},
                "location_name": "Home Assistant",
                "time_zone": "UTC",
                "components": ["api", "websocket", "mobile_app", "device_tracker", "sensor"],
                "version": "2026.9.1"
            }
        })

    elif cmd_type == "subscribe_events":
        event_type = msg.get("event_type", "state_changed")

        # Define dynamic callback to send events belonging to this session's user
        async def event_callback(event_obj: Dict[str, Any]) -> None:
            # Enforce user boundary/isolation
            if event_obj.get("context", {}).get("user_id") == user_id:
                await session.send_json({
                    "id": cmd_id,  # Critical: Must match client's subscription request ID!
                    "type": "event",
                    "event": event_obj
                })

        # Register event listener
        unsubscribe_func = event_bus.subscribe(event_type, event_callback)
        session.subscriptions[cmd_id] = unsubscribe_func

        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": None
        })
        logger.info(f"User {user_id} subscribed to WebSocket event type: {event_type} (sub_id: {cmd_id})")

    elif cmd_type == "unsubscribe_events":
        sub_id = msg.get("subscription")
        if isinstance(sub_id, int) and sub_id in session.subscriptions:
            unsubscribe_func = session.subscriptions.pop(sub_id)
            try:
                unsubscribe_func()
            except Exception:
                pass
            await session.send_json({
                "id": cmd_id,
                "type": "result",
                "success": True,
                "result": None
            })
            logger.info(f"User {user_id} unsubscribed from event ID: {sub_id}")
        else:
            await session.send_json({
                "id": cmd_id,
                "type": "result",
                "success": False,
                "error": {"code": "not_found", "message": "Subscription ID not active or found."}
            })

    elif cmd_type == "get_services":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": {}
        })

    elif cmd_type == "get_panels":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": {
                "lovelace": {
                    "title": "Home",
                    "icon": "mdi:home-assistant",
                    "url_path": "lovelace",
                    "config": {"views": []}
                }
            }
        })

    elif cmd_type == "frontend/get_translations":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": {"resources": {}}
        })

    elif cmd_type == "manifest/list":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": []
        })

    elif cmd_type == "config/device_registry/list":
        async with async_session_maker() as db:
            from app.db.models import Device
            stmt = select(Device).where(Device.user_id == user_id)
            res = await db.execute(stmt)
            devices = res.scalars().all()
            device_list = [
                {
                    "id": str(d.id),
                    "name": d.device_name,
                    "model": d.model,
                    "manufacturer": d.manufacturer,
                    "sw_version": d.os_version,
                    "identifiers": [["mobile_app", d.device_id]],
                    "connections": [],
                    "area_id": None,
                    "disabled_by": None,
                    "entry_type": None
                }
                for d in devices
            ]
            await session.send_json({
                "id": cmd_id,
                "type": "result",
                "success": True,
                "result": device_list
            })

    elif cmd_type == "config/entity_registry/list":
        async with async_session_maker() as db:
            from app.db.models import EntityState
            stmt = select(EntityState).where(EntityState.user_id == user_id)
            res = await db.execute(stmt)
            entities = res.scalars().all()
            entity_list = [
                {
                    "entity_id": e.entity_id,
                    "name": e.attributes.get("friendly_name") if isinstance(e.attributes, dict) else None,
                    "icon": e.attributes.get("icon") if isinstance(e.attributes, dict) else None,
                    "platform": "mobile_app",
                    "config_entry_id": None,
                    "device_id": str(e.device_id) if e.device_id else None,
                    "area_id": None,
                    "disabled_by": None,
                    "capabilities": {}
                }
                for e in entities
            ]
            await session.send_json({
                "id": cmd_id,
                "type": "result",
                "success": True,
                "result": entity_list
            })

    elif cmd_type == "config/area_registry/list":
        async with async_session_maker() as db:
            from app.db.models import Place, CircleMember
            stmt_circles = select(CircleMember.circle_id).where(CircleMember.user_id == user_id)
            res_circles = await db.execute(stmt_circles)
            circle_ids = res_circles.scalars().all()
            area_list = []
            if circle_ids:
                stmt_places = select(Place).where(Place.circle_id.in_(circle_ids))
                res_places = await db.execute(stmt_places)
                places = res_places.scalars().all()
                area_list = [
                    {
                        "area_id": f"area_{p.id}",
                        "name": p.name,
                        "picture": None,
                        "aliases": []
                    }
                    for p in places
                ]
            await session.send_json({
                "id": cmd_id,
                "type": "result",
                "success": True,
                "result": area_list
            })

    elif cmd_type == "frontend/get_user_data":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": {
                "show_advanced_options": False
            }
        })

    elif cmd_type == "persistent_notification/get":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": []
        })

    elif cmd_type == "subscribe_trigger":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": None
        })

    elif cmd_type == "call_service":
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": True,
            "result": {
                "context": {
                    "id": f"ctx_{cmd_id}",
                    "user_id": str(user_id)
                }
            }
        })

    else:
        # Return elegant error for unrecognized commands to prevent connection crashes
        logger.warning(f"Unsupported command type received: {cmd_type}")
        await session.send_json({
            "id": cmd_id,
            "type": "result",
            "success": False,
            "error": {"code": "not_supported", "message": f"Command '{cmd_type}' is not supported."}
        })
