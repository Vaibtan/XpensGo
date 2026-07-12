import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

from xpensego.alerts import check_budget_alerts
from xpensego.db import get_connection, migrate


IST = ZoneInfo("Asia/Kolkata")


async def _seed_entry(
    db,
    *,
    user_id: str,
    entry_type: str,
    amount: float,
    txn_date: str,
    deleted_at: str | None = None,
) -> None:
    await db.execute(
        """
        INSERT INTO entries (
            ledger_id, user_id, paid_by, type, amount, category, description, txn_date, source,
            deleted_at
        ) VALUES (?, ?, ?, ?, ?, 'Food & Dining', 'test entry', ?, 'manual', ?)
        """,
        (f"user:{user_id}", user_id, user_id, entry_type, amount, txn_date, deleted_at),
    )


def test_check_budget_alerts_uses_current_ist_month_live_debits_and_sends_each_threshold_once(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            await db.execute(
                "INSERT INTO budgets (ledger_id, category, monthly_limit) VALUES (?, ?, ?)",
                ("user:user-a", "Food & Dining", 1000),
            )
            await db.execute(
                "INSERT INTO budgets (ledger_id, category, monthly_limit) VALUES (?, ?, ?)",
                ("user:user-b", "Food & Dining", 1000),
            )
            await _seed_entry(
                db, user_id="user-a", entry_type="debit", amount=650, txn_date="2026-05-02"
            )
            await _seed_entry(
                db, user_id="user-a", entry_type="debit", amount=150, txn_date="2026-05-03"
            )
            await _seed_entry(
                db, user_id="user-a", entry_type="credit", amount=900, txn_date="2026-05-04"
            )
            await _seed_entry(
                db,
                user_id="user-a",
                entry_type="debit",
                amount=300,
                txn_date="2026-05-05",
                deleted_at="2026-05-06T00:00:00",
            )
            await _seed_entry(
                db, user_id="user-a", entry_type="debit", amount=400, txn_date="2026-04-30"
            )
            await _seed_entry(
                db, user_id="user-a", entry_type="debit", amount=500, txn_date="2026-05-16"
            )
            await _seed_entry(
                db, user_id="user-b", entry_type="debit", amount=1000, txn_date="2026-05-02"
            )
            now = datetime(2026, 5, 15, 20, 0, tzinfo=IST)

            first = await check_budget_alerts(db, now=now)
            second = await check_budget_alerts(db, now=now)

            assert first == [
                {
                    "ledger_id": "user:user-a",
                    "category": "Food & Dining",
                    "monthly_limit": 1000.0,
                    "spent": 800.0,
                    "percent_used": 80.0,
                    "threshold": 80,
                    "days_left": 16,
                    "month": "2026-05",
                },
                {
                    "ledger_id": "user:user-b",
                    "category": "Food & Dining",
                    "monthly_limit": 1000.0,
                    "spent": 1000.0,
                    "percent_used": 100.0,
                    "threshold": 80,
                    "days_left": 16,
                    "month": "2026-05",
                },
                {
                    "ledger_id": "user:user-b",
                    "category": "Food & Dining",
                    "monthly_limit": 1000.0,
                    "spent": 1000.0,
                    "percent_used": 100.0,
                    "threshold": 100,
                    "days_left": 16,
                    "month": "2026-05",
                },
            ]
            assert second == []

            await _seed_entry(
                db, user_id="user-a", entry_type="debit", amount=200, txn_date="2026-05-15"
            )
            hundred_percent = await check_budget_alerts(db, now=now)
            repeated = await check_budget_alerts(db, now=now)

            assert hundred_percent == [
                {
                    "ledger_id": "user:user-a",
                    "category": "Food & Dining",
                    "monthly_limit": 1000.0,
                    "spent": 1000.0,
                    "percent_used": 100.0,
                    "threshold": 100,
                    "days_left": 16,
                    "month": "2026-05",
                }
            ]
            assert repeated == []
            cursor = await db.execute(
                "SELECT ledger_id, category, month, threshold FROM alerts_sent ORDER BY ledger_id, threshold"
            )
            assert await cursor.fetchall() == [
                ("user:user-a", "Food & Dining", "2026-05", 80),
                ("user:user-a", "Food & Dining", "2026-05", 100),
                ("user:user-b", "Food & Dining", "2026-05", 80),
                ("user:user-b", "Food & Dining", "2026-05", 100),
            ]

    asyncio.run(exercise())
