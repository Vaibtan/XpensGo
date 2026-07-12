import asyncio

from xpensego.db import get_connection, migrate, upsert_user
from xpensego.handlers.parsing import parse_transactions

SAMPLE = "HDFC Bank: Rs.649.00 debited from a/c **1234 on 03-07-26 to VPA blinkit@ybl (UPI Ref 000000424242)"
REAL = "HDFC Bank: Rs.649.00 debited from a/c **1234 on 03-07-26 to VPA blinkit@ybl (UPI Ref No 654321987654)"


def test_onboarding_sample_is_dry_run_and_first_real_parse_activates_user(tmp_path):
    async def exercise():
        path = tmp_path / "xpensego.db"
        await migrate(path)
        async with get_connection(path) as db:
            await upsert_user(db, "u1", "Asha")
            sample = await parse_transactions(db, "u1", SAMPLE)
            assert sample["inserted"][0]["dry_run"] is True
            assert await (await db.execute("SELECT COUNT(*) FROM entries")).fetchone() == (0,)
            assert await (await db.execute("SELECT onboarded_at FROM users WHERE user_id = 'u1'")).fetchone() == (None,)
            await parse_transactions(db, "u1", REAL)
            assert await (await db.execute("SELECT onboarded_at IS NOT NULL FROM users WHERE user_id = 'u1'")).fetchone() == (1,)
    asyncio.run(exercise())
