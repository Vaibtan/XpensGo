"""Create deterministic buildathon-rehearsal data in the current IST month."""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from xpensego.db import get_connection, migrate, upsert_user
from xpensego.handlers.entries import ledger_id_for

DEMO_USER_ID = "demo-user"


async def seed_demo(db_path: Path) -> None:
    await migrate(db_path)
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    ledger_id = ledger_id_for(DEMO_USER_ID)
    async with get_connection(db_path) as db:
        await upsert_user(db, DEMO_USER_ID, "Xpensego Demo")
        await db.execute("DELETE FROM entries WHERE user_id = ?", (DEMO_USER_ID,))
        await db.execute("DELETE FROM budgets WHERE ledger_id = ?", (ledger_id,))
        rows = [
            ("debit", 2400, "Food & Dining", "Swiggy dinner", today.replace(day=1).isoformat()),
            ("debit", 649, "Groceries", "Blinkit", today.replace(day=min(2, today.day)).isoformat()),
            ("debit", 1800, "Food & Dining", "Zomato", today.isoformat()),
            ("debit", 3000, "Transport", "HPCL petrol", today.isoformat()),
            ("credit", 85000, "Other", "Salary", today.replace(day=1).isoformat()),
        ]
        await db.executemany(
            """INSERT INTO entries (ledger_id,user_id,paid_by,type,amount,category,description,txn_date,source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')""",
            [(ledger_id, DEMO_USER_ID, DEMO_USER_ID, *row) for row in rows],
        )
        await db.execute(
            "INSERT INTO budgets (ledger_id, category, monthly_limit) VALUES (?, 'Food & Dining', 5000)",
            (ledger_id,),
        )


def main() -> None:
    import os
    asyncio.run(seed_demo(Path(os.getenv("DB_PATH", "./xpensego.db"))))


if __name__ == "__main__":
    main()
