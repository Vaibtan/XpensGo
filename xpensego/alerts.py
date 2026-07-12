"""Current-month budget alert calculation with durable per-threshold guards."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import aiosqlite

IST = ZoneInfo("Asia/Kolkata")
ALERT_THRESHOLDS = (80, 100)


def _ist_now(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(IST)
    if now.tzinfo is None:
        return now.replace(tzinfo=IST)
    return now.astimezone(IST)


def _month_bounds(now: datetime) -> tuple[str, str, int]:
    month_start = now.replace(day=1).date()
    if month_start.month == 12:
        next_month_start = month_start.replace(year=month_start.year + 1, month=1)
    else:
        next_month_start = month_start.replace(month=month_start.month + 1)
    days_left = (next_month_start - now.date()).days - 1
    return (
        month_start.isoformat(),
        month_start.strftime("%Y-%m"),
        days_left,
    )


async def check_budget_alerts(
    db: aiosqlite.Connection, *, now: datetime | None = None
) -> list[dict[str, Any]]:
    """Claim and return newly crossed 80%/100% monthly budget alerts.

    The `alerts_sent` primary key makes each ledger/category/month/threshold alert durable
    and idempotent, including when this function is triggered repeatedly.
    """
    current = _ist_now(now)
    month_start, month, days_left = _month_bounds(current)
    cursor = await db.execute(
        """SELECT b.ledger_id, b.category, b.monthly_limit, COALESCE(SUM(e.amount), 0) AS spent
           FROM budgets AS b
           LEFT JOIN entries AS e
             ON e.ledger_id = b.ledger_id
            AND e.category = b.category
            AND e.type = 'debit'
            AND e.deleted_at IS NULL
            AND e.txn_date >= ?
            AND e.txn_date <= ?
           GROUP BY b.ledger_id, b.category, b.monthly_limit
           ORDER BY b.ledger_id, b.category""",
        (month_start, current.date().isoformat()),
    )

    alerts: list[dict[str, Any]] = []
    for ledger_id, category, monthly_limit, spent in await cursor.fetchall():
        limit = float(monthly_limit)
        total = float(spent)
        percent_used = (total / limit) * 100
        for threshold in ALERT_THRESHOLDS:
            if percent_used < threshold:
                continue
            claim = await db.execute(
                """INSERT INTO alerts_sent (ledger_id, category, month, threshold)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(ledger_id, category, month, threshold) DO NOTHING""",
                (ledger_id, category, month, threshold),
            )
            if claim.rowcount != 1:
                continue
            alerts.append(
                {
                    "ledger_id": ledger_id,
                    "category": category,
                    "monthly_limit": limit,
                    "spent": total,
                    "percent_used": percent_used,
                    "threshold": threshold,
                    "days_left": days_left,
                    "month": month,
                }
            )
    return alerts


def format_alert(alert: dict[str, Any]) -> str:
    return (
        f"⚠️ {alert['category']}: ₹{alert['spent']:,.0f} of ₹{alert['monthly_limit']:,.0f} "
        f"({alert['percent_used']:.0f}%) with {alert['days_left']} days left."
    )
