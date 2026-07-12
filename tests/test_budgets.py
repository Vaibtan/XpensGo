import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from xpensego.db import get_connection, migrate
from xpensego.handlers.budgets import manage_budget


IST = ZoneInfo("Asia/Kolkata")


def _current_ist_month() -> str:
    return datetime.now(IST).strftime("%Y-%m")


async def _seed_entry(
    db,
    *,
    user_id: str,
    entry_type: str,
    amount: float,
    category: str,
    txn_date: str,
    deleted_at: str | None = None,
) -> None:
    await db.execute(
        """
        INSERT INTO entries (
            ledger_id, user_id, paid_by, type, amount, category, description, txn_date, source,
            deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"user:{user_id}",
            user_id,
            user_id,
            entry_type,
            amount,
            category,
            "test entry",
            txn_date,
            "manual",
            deleted_at,
        ),
    )


def test_manage_budget_sets_upserts_and_lists_current_month_debit_spend(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            month = _current_ist_month()
            await manage_budget(
                db,
                "user-a",
                {"action": "set", "category": "Food & Dining", "monthly_limit": 5000},
            )
            updated = await manage_budget(
                db,
                "user-a",
                {"action": "set", "category": "Food & Dining", "monthly_limit": 6000},
            )
            await manage_budget(
                db,
                "user-b",
                {"action": "set", "category": "Food & Dining", "monthly_limit": 999},
            )
            await _seed_entry(
                db,
                user_id="user-a",
                entry_type="debit",
                amount=1200,
                category="Food & Dining",
                txn_date=f"{month}-01",
            )
            await _seed_entry(
                db,
                user_id="user-a",
                entry_type="credit",
                amount=9000,
                category="Food & Dining",
                txn_date=f"{month}-02",
            )
            await _seed_entry(
                db,
                user_id="user-a",
                entry_type="debit",
                amount=200,
                category="Food & Dining",
                txn_date=f"{month}-03",
                deleted_at="2026-01-01T00:00:00",
            )

            listed = await manage_budget(db, "user-a", {"action": "list"})

            assert updated == {
                "budget": {"category": "Food & Dining", "monthly_limit": 6000.0}
            }
            assert listed == {
                "budgets": [
                    {
                        "category": "Food & Dining",
                        "monthly_limit": 6000.0,
                        "spent": 1200.0,
                        "remaining": 4800.0,
                        "percent_used": 20.0,
                    }
                ]
            }

    asyncio.run(exercise())


def test_manage_budget_rejects_invalid_category_limit_and_action(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            with pytest.raises(ValueError, match="unsupported category"):
                await manage_budget(
                    db,
                    "user-a",
                    {"action": "set", "category": "Pet Care", "monthly_limit": 500},
                )
            with pytest.raises(ValueError, match="greater than zero"):
                await manage_budget(
                    db,
                    "user-a",
                    {"action": "set", "category": "Other", "monthly_limit": 0},
                )
            with pytest.raises(ValueError, match="unsupported budget action"):
                await manage_budget(db, "user-a", {"action": "delete"})

    asyncio.run(exercise())
