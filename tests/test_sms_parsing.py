import asyncio

from xpensego.db import get_connection, migrate
from xpensego.handlers.parsing import parse_transactions, resolve_pending

BLINKIT = "HDFC Bank: Rs.649.00 debited from a/c **1234 on 03-07-26 to VPA blinkit@ybl (UPI Ref No 654321987654)."
ZOMATO = "Dear Customer, Rs.450.00 debited from A/c XX5678 on 02Jul26 towards ZOMATO ONLINE. Avl Bal Rs.23,456.78. -SBI"
SALARY = "HDFC Bank: Rs.85,000.00 credited to a/c **1234 on 01-07-26 by a/c linked to VPA acmecorp.payroll@icici (ACME SALARY JUL)."


def test_sms_parser_preserves_raw_input_categorizes_and_marks_credits(tmp_path):
    async def exercise():
        path = tmp_path / "xpensego.db"
        await migrate(path)
        async with get_connection(path) as db:
            result = await parse_transactions(db, "u1", "\n\n".join([BLINKIT, ZOMATO, SALARY]))
            assert [(item["amount"], item["category"], item["type"]) for item in result["inserted"]] == [
                (649.0, "Groceries", "debit"),
                (450.0, "Food & Dining", "debit"),
                (85000.0, "Other", "credit"),
            ]
            row = await (await db.execute("SELECT raw_input FROM entries WHERE id = 1")).fetchone()
            assert row[0] == BLINKIT

    asyncio.run(exercise())


def test_sms_duplicate_is_pending_and_resolves_without_model_transcription(tmp_path):
    async def exercise():
        path = tmp_path / "xpensego.db"
        await migrate(path)
        async with get_connection(path) as db:
            await parse_transactions(db, "u1", BLINKIT)
            duplicate = await parse_transactions(db, "u1", BLINKIT)
            assert duplicate["inserted"] == []
            assert len(duplicate["pending"]) == 1
            moved = await resolve_pending(db, "u1", [duplicate["pending"][0]["pending_id"]], "log")
            assert moved["resolved"] == 1
            assert await (await db.execute("SELECT COUNT(*) FROM entries")).fetchone() == (2,)

    asyncio.run(exercise())
