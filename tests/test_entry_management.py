import asyncio

from xpensego.db import get_connection, migrate
from xpensego.handlers.entries import delete_last_entry, purge_my_data, recategorize_entry


def test_recategorize_delete_and_purge_keep_user_scope(tmp_path):
    async def exercise():
        path = tmp_path / "xpensego.db"
        await migrate(path)
        async with get_connection(path) as db:
            await db.execute("INSERT INTO users (user_id) VALUES ('u1'), ('u2')")
            await db.execute("INSERT INTO entries (ledger_id,user_id,paid_by,type,amount,category,description,txn_date,source) VALUES ('user:u1','u1','u1','debit',500,'Other','blinkit','2026-07-12','manual')")
            await db.execute("INSERT INTO entries (ledger_id,user_id,paid_by,type,amount,category,description,txn_date,source) VALUES ('user:u2','u2','u2','debit',99,'Food & Dining','chai','2026-07-12','manual')")
            changed = await recategorize_entry(db, "u1", 1, "Groceries")
            assert changed["category"] == "Groceries"
            deleted = await delete_last_entry(db, "u1")
            assert deleted["id"] == 1
            assert await (await db.execute("SELECT deleted_at IS NOT NULL FROM entries WHERE id = 1")).fetchone() == (1,)
            await db.execute("INSERT INTO cost_log (user_id,operation,model,input_tokens,output_tokens,cost_usd) VALUES ('u1','agent_turn','gpt',1,1,0)")
            await purge_my_data(db, "u1")
            assert await (await db.execute("SELECT COUNT(*) FROM entries WHERE user_id = 'u1'")).fetchone() == (0,)
            assert await (await db.execute("SELECT COUNT(*) FROM entries WHERE user_id = 'u2'")).fetchone() == (1,)
            assert await (await db.execute("SELECT user_id FROM cost_log")).fetchone() == (None,)

    asyncio.run(exercise())
