import asyncio
from datetime import date

import pytest

from xpensego.db import get_connection, migrate
from xpensego.handlers.entries import DEFAULT_CATEGORIES, log_entries


def test_log_entries_injects_ledger_identity_and_records_credit_and_debit(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            result = await log_entries(
                db,
                "telegram-user-a",
                {
                    "entries": [
                        {
                            "type": "debit",
                            "amount": 30,
                            "category": "Food & Dining",
                            "description": "chai",
                            "txn_date": "2026-07-12",
                        },
                        {
                            "type": "credit",
                            "amount": 85000,
                            "category": "Other",
                            "description": "salary",
                            "txn_date": "2026-07-12",
                        },
                    ]
                },
            )
            assert [entry["id"] for entry in result["inserted"]]
            assert [entry["type"] for entry in result["inserted"]] == ["debit", "credit"]

            cursor = await db.execute(
                "SELECT ledger_id, user_id, paid_by, type, amount, source FROM entries ORDER BY id"
            )
            assert await cursor.fetchall() == [
                ("user:telegram-user-a", "telegram-user-a", "telegram-user-a", "debit", 30.0, "manual"),
                ("user:telegram-user-a", "telegram-user-a", "telegram-user-a", "credit", 85000.0, "manual"),
            ]

    asyncio.run(exercise())


def test_log_entries_rejects_categories_outside_the_fixed_taxonomy(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            with pytest.raises(ValueError, match="unsupported category"):
                await log_entries(
                    db,
                    "telegram-user-a",
                    {
                        "entries": [
                            {
                                "type": "debit",
                                "amount": 50,
                                "category": "Pet Care",
                                "description": "dog food",
                                "txn_date": date.today().isoformat(),
                            }
                        ]
                    },
                )

    asyncio.run(exercise())


def test_fixed_taxonomy_has_the_fourteen_product_categories():
    assert len(DEFAULT_CATEGORIES) == 14
    assert "Groceries" in DEFAULT_CATEGORIES
    assert "Food & Dining" in DEFAULT_CATEGORIES
