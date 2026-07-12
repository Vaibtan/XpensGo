import asyncio

from xpensego.db import get_connection
from xpensego.seed_demo import DEMO_USER_ID, seed_demo


def test_demo_seed_is_idempotent_and_contains_budget_alert_data(tmp_path):
    async def exercise():
        db_path = tmp_path / "demo.db"
        await seed_demo(db_path)
        await seed_demo(db_path)
        async with get_connection(db_path) as db:
            count = await (await db.execute("SELECT COUNT(*) FROM entries WHERE user_id = ?", (DEMO_USER_ID,))).fetchone()
            assert count == (5,)
            budget = await (await db.execute("SELECT monthly_limit FROM budgets WHERE ledger_id = ?", (f"user:{DEMO_USER_ID}",))).fetchone()
            assert budget == (5000.0,)
    asyncio.run(exercise())
