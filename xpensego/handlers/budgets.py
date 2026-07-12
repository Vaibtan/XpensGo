"""Server-scoped monthly budget operations."""

from __future__ import annotations

from datetime import datetime
from math import isfinite
from typing import Any
from zoneinfo import ZoneInfo

import aiosqlite

from xpensego.handlers.entries import DEFAULT_CATEGORIES, ledger_id_for

IST = ZoneInfo("Asia/Kolkata")


def _current_month_bounds() -> tuple[str, str]:
    now = datetime.now(IST)
    month_start = now.replace(day=1).date()
    if month_start.month == 12:
        next_month_start = month_start.replace(year=month_start.year + 1, month=1)
    else:
        next_month_start = month_start.replace(month=month_start.month + 1)
    return month_start.isoformat(), next_month_start.isoformat()


async def manage_budget(
    db: aiosqlite.Connection, user_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Set or list budgets without accepting a client-controlled ledger identity."""
    action = payload.get("action")
    ledger_id = ledger_id_for(user_id)

    if action == "set":
        category = payload.get("category")
        if category not in DEFAULT_CATEGORIES:
            raise ValueError(f"unsupported category: {category}")
        try:
            monthly_limit = float(payload["monthly_limit"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("monthly_limit must be greater than zero") from error
        if not isfinite(monthly_limit) or monthly_limit <= 0:
            raise ValueError("monthly_limit must be greater than zero")
        await db.execute(
            """INSERT INTO budgets (ledger_id, category, monthly_limit) VALUES (?, ?, ?)
               ON CONFLICT(ledger_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit""",
            (ledger_id, category, monthly_limit),
        )
        return {"budget": {"category": category, "monthly_limit": monthly_limit}}

    if action == "list":
        month_start, next_month_start = _current_month_bounds()
        cursor = await db.execute(
            """SELECT b.category, b.monthly_limit, COALESCE(SUM(e.amount), 0) AS spent
               FROM budgets AS b
               LEFT JOIN entries AS e
                 ON e.ledger_id = b.ledger_id
                AND e.category = b.category
                AND e.type = 'debit'
                AND e.deleted_at IS NULL
                AND e.txn_date >= ?
                AND e.txn_date < ?
               WHERE b.ledger_id = ?
               GROUP BY b.category, b.monthly_limit
               ORDER BY b.category""",
            (month_start, next_month_start, ledger_id),
        )
        budgets = []
        for category, monthly_limit, spent in await cursor.fetchall():
            limit = float(monthly_limit)
            used = float(spent)
            budgets.append(
                {
                    "category": category,
                    "monthly_limit": limit,
                    "spent": used,
                    "remaining": limit - used,
                    "percent_used": (used / limit) * 100,
                }
            )
        return {"budgets": budgets}

    raise ValueError(f"unsupported budget action: {action}")
