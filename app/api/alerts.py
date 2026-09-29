import logging
from typing import List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_authenticated_user
from app.db.database import get_db
from app.db.models import User, Circle, CircleMember
from app.schemas.alerts import AlertResponse, AlertMarkReadResponse
from app.services.alert_service import AlertService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/circles", tags=["Alerts"])

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

@router.get("/{circle_id}/alerts", response_model=List[AlertResponse])
async def list_alerts(
    circle_id: int,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    await check_circle_membership(circle_id, user.id, db)
    alerts = await AlertService.get_circle_alerts(
        db=db,
        circle_id=circle_id,
        user_id=user.id,
        limit=limit,
        offset=offset
    )
    return alerts

@router.put("/{circle_id}/alerts/{alert_id}/read", response_model=AlertResponse)
async def mark_alert_read(
    circle_id: int,
    alert_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_authenticated_user)
):
    await check_circle_membership(circle_id, user.id, db)
    alert = await AlertService.mark_alert_read(
        db=db,
        circle_id=circle_id,
        alert_id=alert_id,
        user_id=user.id
    )
    if not alert:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Alert not found in this circle for this user"
        )
    return alert
