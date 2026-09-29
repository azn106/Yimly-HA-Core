import logging
from typing import List
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_authenticated_user
from app.db.database import get_db
from app.db.models import User, Circle, CircleMember, Place
from app.schemas.places import PlaceCreate, PlaceUpdate, PlaceResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/circles", tags=["Places"])

async def check_circle_membership(circle_id: int, user_id: int, db: AsyncSession) -> Circle:
    # Verify circle exists
    stmt_circle = select(Circle).where(Circle.id == circle_id)
    res_circle = await db.execute(stmt_circle)
    circle = res_circle.scalar_one_or_none()
    if not circle:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Circle not found"
        )

    # Verify user is a member of circle
    stmt_member = select(CircleMember).where(
        CircleMember.circle_id == circle_id,
        CircleMember.user_id == user_id
    )
    res_member = await db.execute(stmt_member)
    if not res_member.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: You are not a member of this circle"
        )

    return circle

@router.get("/{circle_id}/places", response_model=List[PlaceResponse])
async def list_places(
    circle_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    await check_circle_membership(circle_id, user.id, db)

    stmt = select(Place).where(Place.circle_id == circle_id).order_by(Place.created_at.asc())
    result = await db.execute(stmt)
    places = result.scalars().all()
    return places

@router.post("/{circle_id}/places", response_model=PlaceResponse, status_code=status.HTTP_201_CREATED)
async def create_place(
    circle_id: int,
    place_in: PlaceCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    await check_circle_membership(circle_id, user.id, db)

    now = datetime.now(timezone.utc)
    new_place = Place(
        circle_id=circle_id,
        name=place_in.name,
        address=place_in.address,
        latitude=place_in.latitude,
        longitude=place_in.longitude,
        radius=place_in.radius,
        icon=place_in.icon,
        created_at=now,
        updated_at=now
    )
    db.add(new_place)
    await db.commit()
    await db.refresh(new_place)

    return new_place

@router.get("/{circle_id}/places/{place_id}", response_model=PlaceResponse)
async def get_place(
    circle_id: int,
    place_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    await check_circle_membership(circle_id, user.id, db)

    stmt = select(Place).where(
        Place.id == place_id,
        Place.circle_id == circle_id
    )
    res = await db.execute(stmt)
    place = res.scalar_one_or_none()

    if not place:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Place not found in this circle"
        )

    return place

@router.put("/{circle_id}/places/{place_id}", response_model=PlaceResponse)
async def update_place(
    circle_id: int,
    place_id: int,
    place_in: PlaceUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    await check_circle_membership(circle_id, user.id, db)

    stmt = select(Place).where(
        Place.id == place_id,
        Place.circle_id == circle_id
    )
    res = await db.execute(stmt)
    place = res.scalar_one_or_none()

    if not place:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Place not found in this circle"
        )

    if place_in.name is not None:
        place.name = place_in.name
    if place_in.address is not None:
        place.address = place_in.address
    if place_in.latitude is not None:
        place.latitude = place_in.latitude
    if place_in.longitude is not None:
        place.longitude = place_in.longitude
    if place_in.radius is not None:
        place.radius = place_in.radius
    if place_in.icon is not None:
        place.icon = place_in.icon

    place.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(place)

    return place

@router.delete("/{circle_id}/places/{place_id}")
async def delete_place(
    circle_id: int,
    place_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    await check_circle_membership(circle_id, user.id, db)

    stmt = select(Place).where(
        Place.id == place_id,
        Place.circle_id == circle_id
    )
    res = await db.execute(stmt)
    place = res.scalar_one_or_none()

    if not place:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Place not found in this circle"
        )

    await db.delete(place)
    await db.commit()

    return {"detail": "Place deleted successfully"}
