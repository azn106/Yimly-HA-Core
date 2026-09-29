from typing import List, Optional
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Alert
from app.schemas.alerts import AlertCreate, ALLOWED_ALERT_TYPES
from app.services.event_service import event_bus

class AlertService:
    @staticmethod
    async def create_alert(db: AsyncSession, alert_in: AlertCreate) -> Alert:
        if alert_in.alert_type not in ALLOWED_ALERT_TYPES:
            raise ValueError(f"Invalid alert_type '{alert_in.alert_type}'. Must be one of {ALLOWED_ALERT_TYPES}")

        alert = Alert(
            circle_id=alert_in.circle_id,
            user_id=alert_in.user_id,
            target_user_id=alert_in.target_user_id,
            alert_type=alert_in.alert_type,
            title=alert_in.title,
            message=alert_in.message,
            read=False
        )
        db.add(alert)
        await db.commit()
        await db.refresh(alert)

        # Fire internal EventBus alert event
        await event_bus.fire(
            event_type="alert_created",
            event_data={
                "id": alert.id,
                "circle_id": alert.circle_id,
                "user_id": alert.user_id,
                "target_user_id": alert.target_user_id,
                "alert_type": alert.alert_type,
                "title": alert.title,
                "message": alert.message,
                "read": alert.read,
                "created_at": alert.created_at.isoformat() if alert.created_at else None
            },
            user_id=alert.user_id
        )

        return alert

    @staticmethod
    async def get_circle_alerts(
        db: AsyncSession,
        circle_id: int,
        user_id: int,
        limit: int = 50,
        offset: int = 0
    ) -> List[Alert]:
        stmt = (
            select(Alert)
            .where(
                Alert.circle_id == circle_id,
                Alert.user_id == user_id
            )
            .order_by(Alert.created_at.desc())
            .limit(min(limit, 100))
            .offset(offset)
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def mark_alert_read(
        db: AsyncSession,
        circle_id: int,
        alert_id: int,
        user_id: int
    ) -> Optional[Alert]:
        stmt = select(Alert).where(
            Alert.id == alert_id,
            Alert.circle_id == circle_id,
            Alert.user_id == user_id
        )
        result = await db.execute(stmt)
        alert = result.scalar_one_or_none()

        if not alert:
            return None

        alert.read = True
        await db.commit()
        await db.refresh(alert)

        return alert

    @staticmethod
    async def mark_all_alerts_read(
        db: AsyncSession,
        circle_id: int,
        user_id: int
    ) -> int:
        stmt = (
            update(Alert)
            .where(
                Alert.circle_id == circle_id,
                Alert.user_id == user_id,
                Alert.read == False
            )
            .values(read=True)
        )
        result = await db.execute(stmt)
        await db.commit()
        return getattr(result, "rowcount", 0)
