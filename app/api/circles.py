import uuid
import logging
from typing import List, Optional
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_authenticated_user
from app.db.database import get_db
from app.db.models import User, Circle, CircleMember, EntityState
from app.schemas.circles import (
    CircleCreate, CircleJoin, CircleResponse, MemberResponse, MemberDeviceLocation,
    MemberCreate, MemberUpdate, HADeviceResponse
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/circles", tags=["Circles"])

def generate_invite_code() -> str:
    # Generates a clean 8-character uppercase alphanumeric code
    return str(uuid.uuid4()).replace("-", "")[:8].upper()

def _entity_state_to_device_location(
    st: EntityState,
    is_default: bool = False,
    now_iso: Optional[str] = None
) -> Optional[MemberDeviceLocation]:
    if st.latitude is None or st.longitude is None:
        return None
    attrs = st.attributes if isinstance(st.attributes, dict) else {}
    friendly_name = attrs.get("friendly_name") or st.entity_id
    battery_val = attrs.get("battery")
    if battery_val is None:
        battery_val = attrs.get("battery_level")
    if battery_val is None:
        battery_val = attrs.get("battery_bar")
    accuracy = attrs.get("gps_accuracy")
    map_icon = attrs.get("map_icon") or "📱 Phone"
    loc_vis = attrs.get("location_visibility") or "family"
    is_def = bool(attrs.get("is_default", is_default))
    if not now_iso:
        now_iso = datetime.now(timezone.utc).isoformat()
    last_updated_str = (
        st.last_updated.isoformat()
        if hasattr(st.last_updated, "isoformat")
        else str(st.last_updated)
        if st.last_updated
        else now_iso
    )

    return MemberDeviceLocation(
        entity_id=st.entity_id,
        device_name=friendly_name,
        latitude=st.latitude,
        longitude=st.longitude,
        battery=battery_val,
        charging=attrs.get("charging"),
        accuracy=accuracy,
        last_updated=last_updated_str,
        map_icon=map_icon,
        location_visibility=loc_vis,
        is_default=is_def
    )

@router.post("", response_model=CircleResponse)
async def create_circle(
    circle_in: CircleCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    invite_code = generate_invite_code()
    
    # Ensure code is unique in the DB
    for _ in range(5):
        stmt = select(Circle).where(Circle.invite_code == invite_code)
        res = await db.execute(stmt)
        if not res.scalar_one_or_none():
            break
        invite_code = generate_invite_code()

    new_circle = Circle(
        name=circle_in.name,
        owner_id=user.id,
        invite_code=invite_code
    )
    db.add(new_circle)
    await db.commit()
    await db.refresh(new_circle)

    # Automatically add owner as a member
    member = CircleMember(
        circle_id=new_circle.id,
        user_id=user.id,
        display_name=user.display_name,
        avatar_color=user.avatar_color,
        profile_picture_url=user.profile_picture_url,
        assigned_entity_id=getattr(user, "assigned_entity_id", None)
    )
    db.add(member)
    await db.commit()

    return new_circle

@router.post("/join", response_model=CircleResponse)
async def join_circle(
    join_in: CircleJoin,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    normalized_code = join_in.invite_code.strip().upper()
    stmt = select(Circle).where(Circle.invite_code == normalized_code)
    result = await db.execute(stmt)
    circle = result.scalar_one_or_none()

    if not circle:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invitation code not found or invalid."
        )

    # Check if already a member
    stmt_member = select(CircleMember).where(
        CircleMember.circle_id == circle.id,
        CircleMember.user_id == user.id
    )
    res_member = await db.execute(stmt_member)
    if res_member.scalar_one_or_none():
        return circle

    new_member = CircleMember(
        circle_id=circle.id,
        user_id=user.id,
        display_name=user.display_name,
        avatar_color=user.avatar_color,
        profile_picture_url=user.profile_picture_url,
        assigned_entity_id=getattr(user, "assigned_entity_id", None)
    )
    db.add(new_member)
    await db.commit()

    return circle

@router.post("/{circle_id}/leave")
async def leave_circle(
    circle_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    # Verify circle exists
    stmt_circle = select(Circle).where(Circle.id == circle_id)
    res_circle = await db.execute(stmt_circle)
    circle = res_circle.scalar_one_or_none()
    if not circle:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Circle not found."
        )

    if circle.owner_id == user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Circle owner cannot leave the circle. Delete the circle instead."
        )

    stmt_member = select(CircleMember).where(
        CircleMember.circle_id == circle_id,
        CircleMember.user_id == user.id
    )
    res_member = await db.execute(stmt_member)
    member = res_member.scalar_one_or_none()
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="You are not a member of this circle."
        )

    await db.delete(member)
    await db.commit()
    return {"status": "success", "message": "Successfully left the circle."}

@router.delete("/{circle_id}")
async def delete_circle(
    circle_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    stmt = select(Circle).where(Circle.id == circle_id)
    res = await db.execute(stmt)
    circle = res.scalar_one_or_none()

    if not circle:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Circle not found."
        )

    if circle.owner_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the circle creator / owner can delete this Circle."
        )

    circle_name = circle.name
    await db.delete(circle)
    await db.commit()

    return {
        "status": "success",
        "message": f'Family Circle "{circle_name}" has been deleted.'
    }

@router.get("", response_model=List[CircleResponse])
async def list_circles(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    # Retrieve all circles where user is a member or owner
    stmt = (
        select(Circle)
        .outerjoin(CircleMember, CircleMember.circle_id == Circle.id)
        .where((CircleMember.user_id == user.id) | (Circle.owner_id == user.id))
        .distinct()
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())

@router.get("/{circle_id}/members", response_model=List[MemberResponse])
async def list_circle_members(
    circle_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    # Verify current user is authorized to view this circle (member or owner)
    stmt_circle = select(Circle).where(Circle.id == circle_id)
    res_circle = await db.execute(stmt_circle)
    circle = res_circle.scalar_one_or_none()
    if not circle:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Circle not found.")

    stmt_check = select(CircleMember).where(
        CircleMember.circle_id == circle_id,
        CircleMember.user_id == user.id
    )
    res_check = await db.execute(stmt_check)
    if not res_check.scalar_one_or_none() and circle.owner_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to view this Circle."
        )

    # Query all members of the circle
    stmt_members = select(CircleMember).where(CircleMember.circle_id == circle_id)
    res_members = await db.execute(stmt_members)
    circle_members = res_members.scalars().all()

    # Pre-fetch users for linked user_ids
    user_ids = [cm.user_id for cm in circle_members if cm.user_id]
    users_by_id = {}
    if user_ids:
        stmt_u = select(User).where(User.id.in_(user_ids))
        res_u = await db.execute(stmt_u)
        for u in res_u.scalars().all():
            users_by_id[u.id] = u

    response: List[MemberResponse] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for cm in circle_members:
        linked_user = users_by_id.get(cm.user_id) if cm.user_id else None
        
        display_name = cm.display_name or (linked_user.display_name if linked_user else "Family Member")
        username = (linked_user.username if linked_user else f"member_{cm.id}")
        avatar_color = cm.avatar_color or (linked_user.avatar_color if linked_user else None)
        profile_picture_url = cm.profile_picture_url or (linked_user.profile_picture_url if linked_user else None)
        assigned_entity_id = cm.assigned_entity_id or (getattr(linked_user, "assigned_entity_id", None) if linked_user else None)
        is_owner = bool(circle.owner_id == (linked_user.id if linked_user else None))

        devices_loc: List[MemberDeviceLocation] = []

        # 1. Resolve local EntityState records for linked user
        if linked_user:
            stmt_states = select(EntityState).where(
                EntityState.user_id == linked_user.id,
                EntityState.domain == "device_tracker"
            )
            res_states = await db.execute(stmt_states)
            device_trackers = res_states.scalars().all()

            for dt in device_trackers:
                loc = _entity_state_to_device_location(dt, now_iso=now_iso)
                if loc:
                    devices_loc.append(loc)

        # 2. If an assigned entity ID is specified and not yet in devices_loc, resolve it from local EntityState
        if assigned_entity_id:
            already_present = any(d.entity_id == assigned_entity_id for d in devices_loc)
            if not already_present:
                stmt_assigned = select(EntityState).where(
                    EntityState.entity_id == assigned_entity_id,
                    EntityState.domain == "device_tracker"
                )
                res_assigned = await db.execute(stmt_assigned)
                dt_assigned = res_assigned.scalar_one_or_none()
                if dt_assigned:
                    loc = _entity_state_to_device_location(dt_assigned, is_default=True, now_iso=now_iso)
                    if loc:
                        devices_loc.append(loc)
            else:
                for d in devices_loc:
                    if d.entity_id == assigned_entity_id:
                        d.is_default = True

        # Sort: default device first
        has_explicit_default = any(d.is_default for d in devices_loc)
        if not has_explicit_default and len(devices_loc) > 0:
            devices_loc[0].is_default = True
        devices_loc.sort(key=lambda d: 0 if d.is_default else 1)

        # Privacy check
        if linked_user and linked_user.id != user.id:
            if getattr(linked_user, "share_location", True) is False:
                filtered_devices = []
            else:
                filtered_devices = devices_loc[:1] if len(devices_loc) > 0 else []
        else:
            filtered_devices = devices_loc

        response.append(MemberResponse(
            id=cm.id,
            username=username,
            display_name=display_name,
            avatar_color=avatar_color,
            profile_picture_url=profile_picture_url,
            assigned_entity_id=assigned_entity_id,
            is_owner=is_owner,
            devices=filtered_devices
        ))

    return response

@router.post("/{circle_id}/members", response_model=MemberResponse)
async def create_circle_member(
    circle_id: int,
    member_in: MemberCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    """
    Creates a new independent Yimly family member profile within the Circle,
    with an optional assigned Home Assistant device_tracker entity.
    """
    # Verify circle exists and user has access
    stmt_circle = select(Circle).where(Circle.id == circle_id)
    res_circle = await db.execute(stmt_circle)
    circle = res_circle.scalar_one_or_none()
    if not circle:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Circle not found.")

    new_member = CircleMember(
        circle_id=circle_id,
        user_id=None,
        display_name=member_in.display_name.strip(),
        avatar_color=member_in.avatar_color,
        profile_picture_url=member_in.profile_picture_url,
        assigned_entity_id=member_in.assigned_entity_id.strip() if member_in.assigned_entity_id else None
    )
    db.add(new_member)
    await db.commit()
    await db.refresh(new_member)

    # Resolve live device location if assigned from local EntityState
    devices_loc: List[MemberDeviceLocation] = []
    if new_member.assigned_entity_id:
        stmt_dt = select(EntityState).where(
            EntityState.entity_id == new_member.assigned_entity_id,
            EntityState.domain == "device_tracker"
        )
        res_dt = await db.execute(stmt_dt)
        dt = res_dt.scalar_one_or_none()
        if dt:
            loc = _entity_state_to_device_location(dt, is_default=True)
            if loc:
                devices_loc.append(loc)

    return MemberResponse(
        id=new_member.id,
        username=f"member_{new_member.id}",
        display_name=new_member.display_name or "Family Member",
        avatar_color=new_member.avatar_color,
        profile_picture_url=new_member.profile_picture_url,
        assigned_entity_id=new_member.assigned_entity_id,
        is_owner=False,
        devices=devices_loc
    )

@router.put("/{circle_id}/members/{member_id}", response_model=MemberResponse)
async def update_circle_member(
    circle_id: int,
    member_id: int,
    member_in: MemberUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    """
    Updates a Yimly member profile: display_name, avatar_color, profile_picture_url,
    or changes/removes their assigned Home Assistant device.
    """
    stmt = select(CircleMember).where(CircleMember.id == member_id, CircleMember.circle_id == circle_id)
    res = await db.execute(stmt)
    member = res.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found.")

    if member_in.display_name is not None:
        member.display_name = member_in.display_name.strip()
    if member_in.avatar_color is not None:
        member.avatar_color = member_in.avatar_color
    if member_in.profile_picture_url is not None:
        member.profile_picture_url = member_in.profile_picture_url
    if member_in.assigned_entity_id is not None:
        clean_entity = member_in.assigned_entity_id.strip()
        member.assigned_entity_id = clean_entity if clean_entity else None

    # If linked to a user and this user is updating their own member profile, sync user table
    if member.user_id == user.id:
        if member_in.display_name:
            user.display_name = member_in.display_name.strip()
        if member_in.avatar_color:
            user.avatar_color = member_in.avatar_color
        if member_in.assigned_entity_id is not None:
            user.assigned_entity_id = member.assigned_entity_id

    await db.commit()
    await db.refresh(member)

    # Resolve live device location if assigned from local EntityState
    devices_loc: List[MemberDeviceLocation] = []
    if member.assigned_entity_id:
        stmt_dt = select(EntityState).where(
            EntityState.entity_id == member.assigned_entity_id,
            EntityState.domain == "device_tracker"
        )
        res_dt = await db.execute(stmt_dt)
        dt = res_dt.scalar_one_or_none()
        if dt:
            loc = _entity_state_to_device_location(dt, is_default=True)
            if loc:
                devices_loc.append(loc)

    return MemberResponse(
        id=member.id,
        username=f"member_{member.id}",
        display_name=member.display_name or "Family Member",
        avatar_color=member.avatar_color,
        profile_picture_url=member.profile_picture_url,
        assigned_entity_id=member.assigned_entity_id,
        is_owner=False,
        devices=devices_loc
    )

@router.delete("/{circle_id}/members/{member_id}")
async def delete_circle_member(
    circle_id: int,
    member_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    """
    Deletes a Yimly member from the Circle.
    """
    stmt = select(CircleMember).where(CircleMember.id == member_id, CircleMember.circle_id == circle_id)
    res = await db.execute(stmt)
    member = res.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found.")

    # Check if this member is circle owner
    stmt_circle = select(Circle).where(Circle.id == circle_id)
    res_c = await db.execute(stmt_circle)
    circle = res_c.scalar_one_or_none()
    if circle and member.user_id == circle.owner_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete the Circle owner. Delete the Circle instead."
        )

    await db.delete(member)
    await db.commit()
    return {"status": "success", "message": "Member removed from circle."}

@router.get("/devices/available", response_model=List[HADeviceResponse])
@router.get("/ha/devices", response_model=List[HADeviceResponse])
@router.get("/ha/discovered-devices", response_model=List[HADeviceResponse])
async def get_available_ha_devices(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    """
    Returns discovered location-capable device_tracker entities from local SQLite.
    Used by the frontend to populate the device assignment dropdown.
    """
    stmt = select(EntityState).where(
        EntityState.domain == "device_tracker"
    )
    res = await db.execute(stmt)
    entities = res.scalars().all()

    devices: List[HADeviceResponse] = []
    for st in entities:
        attrs = st.attributes if isinstance(st.attributes, dict) else {}
        devices.append(HADeviceResponse(
            entity_id=st.entity_id,
            device_name=attrs.get("friendly_name") or st.entity_id,
            state=st.state or "unknown",
            is_available=True,
            latitude=st.latitude,
            longitude=st.longitude,
            accuracy=attrs.get("gps_accuracy"),
            battery=attrs.get("battery") or attrs.get("battery_level"),
            charging=attrs.get("charging"),
            platform=attrs.get("source_type") or "mobile_app",
            last_updated=st.last_updated.isoformat() if hasattr(st.last_updated, "isoformat") else str(st.last_updated) if st.last_updated else None,
            map_icon=attrs.get("map_icon") or "📱 Phone"
        ))
    devices.sort(key=lambda d: d.device_name.lower())
    return devices
