"""Ledger entry write operations with server-enforced tenant scoping."""

from __future__ import annotations

from typing import Any

import aiosqlite

DEFAULT_CATEGORIES = frozenset(
    {
        "Food & Dining", "Groceries", "Transport", "Rent & Utilities", "Shopping", "Entertainment",
        "Health", "Education", "Personal Care", "Subscriptions", "Travel", "Family & Gifts",
        "Fees & Charges", "Other",
    }
)


def ledger_id_for(user_id: str) -> str:
    return f"user:{user_id}"


async def log_entries(db: aiosqlite.Connection, user_id: str, payload: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Insert model-extracted manual entries under the authenticated user's ledger only."""
    entries = payload.get("entries", [])
    if not entries:
        raise ValueError("at least one entry is required")
    inserted: list[dict[str, Any]] = []
    ledger_id = ledger_id_for(user_id)
    for entry in entries:
        category = entry["category"]
        if category not in DEFAULT_CATEGORIES:
            raise ValueError(f"unsupported category: {category}")
        entry_type = entry["type"]
        if entry_type not in {"debit", "credit"}:
            raise ValueError(f"unsupported entry type: {entry_type}")
        amount = float(entry["amount"])
        if amount <= 0:
            raise ValueError("amount must be greater than zero")
        cursor = await db.execute(
            """INSERT INTO entries (ledger_id, user_id, paid_by, type, amount, category, description, txn_date, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')""",
            (ledger_id, user_id, user_id, entry_type, amount, category, entry["description"], entry["txn_date"]),
        )
        inserted.append({"id": cursor.lastrowid, "type": entry_type, "amount": amount, "category": category, "description": entry["description"], "txn_date": entry["txn_date"]})
    await db.execute("UPDATE users SET onboarded_at = COALESCE(onboarded_at, datetime('now')) WHERE user_id = ?", (user_id,))
    teach_payee = payload.get("teach_payee")
    if teach_payee:
        category = teach_payee["category"]
        if category not in DEFAULT_CATEGORIES:
            raise ValueError(f"unsupported category: {category}")
        await db.execute(
            """INSERT INTO payee_memory (user_id, payee, category) VALUES (?, ?, ?)
               ON CONFLICT(user_id, payee) DO UPDATE SET category = excluded.category""",
            (user_id, teach_payee["payee"].strip().lower(), category),
        )
    return {"inserted": inserted}


async def recategorize_entry(db: aiosqlite.Connection, user_id: str, entry_id: int, category: str) -> dict[str, Any]:
    if category not in DEFAULT_CATEGORIES:
        raise ValueError(f"unsupported category: {category}")
    cursor = await db.execute(
        """UPDATE entries SET category = ? WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL
           RETURNING id, amount, category, description, txn_date""",
        (category, entry_id, ledger_id_for(user_id)),
    )
    row = await cursor.fetchone()
    if row is None:
        raise ValueError("entry not found")
    return dict(zip(("id", "amount", "category", "description", "txn_date"), row))


async def delete_last_entry(db: aiosqlite.Connection, user_id: str) -> dict[str, Any]:
    cursor = await db.execute(
        """SELECT id, amount, category, txn_date FROM entries WHERE ledger_id = ? AND deleted_at IS NULL
           ORDER BY id DESC LIMIT 1""",
        (ledger_id_for(user_id),),
    )
    row = await cursor.fetchone()
    if row is None:
        raise ValueError("no live entry to delete")
    await db.execute("UPDATE entries SET deleted_at = datetime('now') WHERE id = ? AND ledger_id = ?", (row[0], ledger_id_for(user_id)))
    return dict(zip(("id", "amount", "category", "txn_date"), row))


async def purge_my_data(db: aiosqlite.Connection, user_id: str) -> None:
    ledger_id = ledger_id_for(user_id)
    for table, predicate, value in (
        ("entries", "user_id", user_id), ("pending_entries", "user_id", user_id), ("payee_memory", "user_id", user_id),
        ("custom_categories", "user_id", user_id), ("conversation_context", "user_id", user_id), ("budgets", "ledger_id", ledger_id),
        ("alerts_sent", "ledger_id", ledger_id), ("users", "user_id", user_id),
    ):
        await db.execute(f"DELETE FROM {table} WHERE {predicate} = ?", (value,))
    await db.execute("UPDATE cost_log SET user_id = NULL WHERE user_id = ?", (user_id,))
