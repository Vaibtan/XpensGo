"""SQLite access and the complete initial Xpensego schema."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import aiosqlite

REQUIRED_TABLES = {
    "users",
    "entries",
    "pending_entries",
    "budgets",
    "payee_memory",
    "custom_categories",
    "conversation_context",
    "alerts_sent",
    "cost_log",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  user_id        TEXT PRIMARY KEY,
  display_name   TEXT,
  onboarded_at   TEXT,
  digest_opt_out INTEGER DEFAULT 0,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  paid_by     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('debit','credit')),
  amount      REAL NOT NULL CHECK (amount > 0),
  category    TEXT NOT NULL,
  subcategory TEXT,
  description TEXT,
  txn_date    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('manual','sms','statement','receipt')),
  raw_input   TEXT,
  deleted_at  TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_ledger_date ON entries(ledger_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_entries_dedup ON entries(ledger_id, amount, txn_date);

CREATE TABLE IF NOT EXISTS pending_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('debit','credit')),
  amount      REAL NOT NULL CHECK (amount > 0),
  category    TEXT NOT NULL,
  description TEXT,
  txn_date    TEXT NOT NULL,
  source      TEXT NOT NULL,
  raw_input   TEXT,
  reason      TEXT NOT NULL DEFAULT 'duplicate',
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  ledger_id     TEXT NOT NULL,
  category      TEXT NOT NULL,
  monthly_limit REAL NOT NULL CHECK (monthly_limit > 0),
  PRIMARY KEY (ledger_id, category)
);

CREATE TABLE IF NOT EXISTS payee_memory (
  user_id  TEXT NOT NULL,
  payee    TEXT NOT NULL,
  category TEXT NOT NULL,
  PRIMARY KEY (user_id, payee)
);

CREATE TABLE IF NOT EXISTS custom_categories (
  user_id  TEXT NOT NULL,
  name     TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS conversation_context (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ctx_user ON conversation_context(user_id, id);

CREATE TABLE IF NOT EXISTS alerts_sent (
  ledger_id TEXT NOT NULL,
  category  TEXT NOT NULL,
  month     TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold IN (80,100)),
  sent_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (ledger_id, category, month, threshold)
);

CREATE TABLE IF NOT EXISTS cost_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,
  operation     TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
);
"""


@asynccontextmanager
async def get_connection(db_path: Path) -> AsyncIterator[aiosqlite.Connection]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = await aiosqlite.connect(db_path)
    try:
        yield connection
        await connection.commit()
    except Exception:
        await connection.rollback()
        raise
    finally:
        await connection.close()


async def migrate(db_path: Path) -> None:
    async with get_connection(db_path) as db:
        await db.executescript(SCHEMA)


async def upsert_user(db: aiosqlite.Connection, user_id: str, display_name: str | None) -> None:
    await db.execute(
        """
        INSERT INTO users (user_id, display_name) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            display_name = COALESCE(excluded.display_name, users.display_name)
        """,
        (user_id, display_name),
    )


async def load_context(db: aiosqlite.Connection, user_id: str, limit: int = 10) -> list[tuple[str, str]]:
    cursor = await db.execute(
        """
        SELECT role, content FROM conversation_context
        WHERE user_id = ? AND created_at >= datetime('now', '-7 days')
        ORDER BY id DESC LIMIT ?
        """,
        (user_id, limit),
    )
    return list(reversed(await cursor.fetchall()))


async def append_context(
    db: aiosqlite.Connection, user_id: str, user_content: str, assistant_content: str
) -> None:
    await db.executemany(
        "INSERT INTO conversation_context (user_id, role, content) VALUES (?, ?, ?)",
        [(user_id, "user", user_content), (user_id, "assistant", assistant_content)],
    )
    await db.execute(
        "DELETE FROM conversation_context WHERE user_id = ? AND created_at < datetime('now', '-7 days')",
        (user_id,),
    )


async def allowed_agent_turn(db: aiosqlite.Connection, user_id: str) -> bool:
    cursor = await db.execute(
        """
        SELECT
            SUM(CASE WHEN created_at >= datetime('now', '-1 hour') THEN 1 ELSE 0 END),
            COUNT(*)
        FROM conversation_context
        WHERE user_id = ? AND role = 'user' AND created_at >= datetime('now', '-1 day')
        """,
        (user_id,),
    )
    hourly, daily = await cursor.fetchone()
    return (hourly or 0) < 30 and (daily or 0) < 150
