import asyncio

from xpensego.db import get_connection, migrate
from xpensego.handlers.queries import query_ledger


async def _seed_entry(
    db,
    *,
    user_id: str,
    entry_type: str,
    amount: float,
    txn_date: str = "2026-07-12",
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
            "Other",
            "test entry",
            txn_date,
            "manual",
            deleted_at,
        ),
    )


def test_query_ledger_total_defaults_to_debits(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            await _seed_entry(db, user_id="user-a", entry_type="debit", amount=125)
            await _seed_entry(db, user_id="user-a", entry_type="credit", amount=900)

            result = await query_ledger(
                db,
                "user-a",
                {"metric": "total", "date_from": "2026-07-01", "date_to": "2026-07-31"},
            )

            assert result["total"] == 125.0
            assert result["type"] == "debit"

    asyncio.run(exercise())


def test_query_ledger_can_return_credit_only_total(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            await _seed_entry(db, user_id="user-a", entry_type="debit", amount=125)
            await _seed_entry(db, user_id="user-a", entry_type="credit", amount=900)

            result = await query_ledger(
                db,
                "user-a",
                {
                    "metric": "total",
                    "type": "credit",
                    "date_from": "2026-07-01",
                    "date_to": "2026-07-31",
                },
            )

            assert result["total"] == 900.0
            assert result["type"] == "credit"

    asyncio.run(exercise())


def test_query_ledger_excludes_soft_deleted_entries(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            await _seed_entry(db, user_id="user-a", entry_type="debit", amount=80)
            await _seed_entry(
                db,
                user_id="user-a",
                entry_type="debit",
                amount=400,
                deleted_at="2026-07-12T12:00:00",
            )

            result = await query_ledger(
                db,
                "user-a",
                {"metric": "total", "date_from": "2026-07-01", "date_to": "2026-07-31"},
            )

            assert result["total"] == 80.0

    asyncio.run(exercise())


def test_query_ledger_scopes_results_to_authenticated_user(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            await _seed_entry(db, user_id="user-a", entry_type="debit", amount=200)
            await _seed_entry(db, user_id="user-b", entry_type="debit", amount=700)

            result = await query_ledger(
                db,
                "user-b",
                {"metric": "total", "date_from": "2026-07-01", "date_to": "2026-07-31"},
            )

            assert result["total"] == 700.0

    asyncio.run(exercise())


def test_query_ledger_dispatches_remaining_metrics_and_comparison(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            await _seed_entry(
                db, user_id="user-a", entry_type="debit", amount=20, txn_date="2026-07-10"
            )
            await _seed_entry(
                db, user_id="user-a", entry_type="debit", amount=80, txn_date="2026-07-11"
            )
            await db.execute(
                "INSERT INTO budgets (ledger_id, category, monthly_limit) VALUES (?, ?, ?)",
                ("user:user-a", "Other", 200),
            )
            slots = {"date_from": "2026-07-10", "date_to": "2026-07-11"}

            listed = await query_ledger(db, "user-a", {"metric": "list", **slots})
            assert [entry["amount"] for entry in listed["entries"]] == [80.0, 20.0]

            maximum = await query_ledger(db, "user-a", {"metric": "max", **slots})
            assert maximum["entry"]["amount"] == 80.0

            average = await query_ledger(db, "user-a", {"metric": "avg_per_day", **slots})
            assert average["avg_per_day"] == 50.0

            counted = await query_ledger(db, "user-a", {"metric": "count", **slots})
            assert counted["count"] == 2

            budget = await query_ledger(db, "user-a", {"metric": "budget_status", **slots})
            assert budget["budgets"] == [
                {
                    "category": "Other",
                    "monthly_limit": 200.0,
                    "spent": 100.0,
                    "remaining": 100.0,
                    "percent_used": 50.0,
                }
            ]

            comparison = await query_ledger(
                db,
                "user-a",
                {
                    "metric": "total",
                    "date_from": "2026-07-11",
                    "date_to": "2026-07-11",
                    "compare_date_from": "2026-07-10",
                    "compare_date_to": "2026-07-10",
                },
            )
            assert comparison["total"] == 80.0
            assert comparison["comparison"]["total"] == 20.0

    asyncio.run(exercise())
