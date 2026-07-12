import asyncio

from xpensego.db import get_connection, migrate
from xpensego.handlers.parsing import parse_csv_statement


def test_csv_statement_categorizes_credits_and_preserves_exact_raw_rows(tmp_path):
    async def exercise():
        path = tmp_path / "xpensego.db"
        await migrate(path)
        csv_bytes = (
            b"Transaction Date,Amount,Narration,Debit_Credit\r\n"
            b"03/07/2026,649.00,\"Blinkit, Order\",DEBIT\r\n"
            b"04/07/2026,-85000.00,ACME SALARY,CREDIT\r\n"
        )
        async with get_connection(path) as db:
            result = await parse_csv_statement(db, "u1", csv_bytes)
            assert [(item["amount"], item["category"], item["type"], item["txn_date"]) for item in result["inserted"]] == [
                (649.0, "Groceries", "debit", "2026-07-03"),
                (85000.0, "Other", "credit", "2026-07-04"),
            ]
            rows = await (
                await db.execute("SELECT source, raw_input FROM entries ORDER BY id")
            ).fetchall()
            assert rows == [
                ("statement", "03/07/2026,649.00,\"Blinkit, Order\",DEBIT"),
                ("statement", "04/07/2026,-85000.00,ACME SALARY,CREDIT"),
            ]

    asyncio.run(exercise())


def test_csv_statement_duplicate_is_pending_with_statement_source(tmp_path):
    async def exercise():
        path = tmp_path / "xpensego.db"
        await migrate(path)
        csv_bytes = b"date,amount,description\n2026-07-03,649.00,Blinkit Order\n"
        async with get_connection(path) as db:
            await parse_csv_statement(db, "u1", csv_bytes)
            duplicate = await parse_csv_statement(db, "u1", csv_bytes)
            assert duplicate["inserted"] == []
            assert len(duplicate["pending"]) == 1
            row = await (
                await db.execute("SELECT source, raw_input FROM pending_entries")
            ).fetchone()
            assert row == ("statement", "2026-07-03,649.00,Blinkit Order")

    asyncio.run(exercise())


def test_csv_statement_returns_clarification_without_writing_when_required_columns_are_missing(tmp_path):
    async def exercise():
        path = tmp_path / "xpensego.db"
        await migrate(path)
        async with get_connection(path) as db:
            result = await parse_csv_statement(db, "u1", b"posted,balance,reference\n2026-07-03,1000,abc\n")
            assert result == {
                "status": "needs_clarification",
                "needs_clarification": {
                    "reason": "missing_columns",
                    "missing_columns": ["date", "amount", "description"],
                    "message": "I couldn't identify the date, amount, and description columns in this CSV.",
                },
            }
            assert await (await db.execute("SELECT COUNT(*) FROM entries")).fetchone() == (0,)

    asyncio.run(exercise())


def test_csv_statement_enforces_byte_and_row_limits_without_writing(tmp_path):
    async def exercise():
        path = tmp_path / "xpensego.db"
        await migrate(path)
        oversized = b"date,amount,description\n" + b"x" * (1024 * 1024)
        too_many_rows = b"date,amount,description\n" + b"2026-07-03,1,Tea\n" * 501
        async with get_connection(path) as db:
            assert (await parse_csv_statement(db, "u1", oversized))["needs_clarification"]["reason"] == "file_too_large"
            assert (await parse_csv_statement(db, "u1", too_many_rows))["needs_clarification"]["reason"] == "too_many_rows"
            assert await (await db.execute("SELECT COUNT(*) FROM entries")).fetchone() == (0,)

    asyncio.run(exercise())
