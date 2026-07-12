"""Deterministic SMS extraction, categorization, and duplicate holding pipeline."""

from __future__ import annotations

import re
from datetime import datetime
from difflib import SequenceMatcher
from typing import Any
from zoneinfo import ZoneInfo

import aiosqlite

from xpensego.handlers.entries import ledger_id_for

SAMPLE_UPI_REF = "000000424242"

MERCHANT_CATEGORIES = {
    "blinkit": "Groceries", "zepto": "Groceries", "instamart": "Groceries", "bigbasket": "Groceries",
    "general store": "Groceries", "kirana": "Groceries", "zomato": "Food & Dining", "swiggy": "Food & Dining",
    "uber": "Transport", "ola": "Transport", "rapido": "Transport", "metro": "Transport", "petrol": "Transport",
    "netflix": "Subscriptions", "hotstar": "Subscriptions", "gym": "Subscriptions", "myntra": "Shopping",
    "amazon": "Shopping", "apollo pharmacy": "Health", "makemytrip": "Travel", "bookmyshow": "Entertainment",
    "electricity": "Rent & Utilities", "bses": "Rent & Utilities", "recharge": "Rent & Utilities",
}


def split_sms(raw_text: str) -> list[str]:
    text = raw_text.strip()
    if not text:
        return []
    chunks = re.split(r"\n\s*\n+", text)
    return [chunk.strip() for chunk in chunks if chunk.strip()][:50]


def _amount(text: str) -> float | None:
    patterns = [
        r"(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:debited|credited)",
        r"(?:debited(?:\s+for)?|credited(?:\s+to\s+[^;]+?\s+on\s+\S+\s+by\s+[^;]+?))\s*(?:for\s*)?(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)",
        r"(?:Paid\s+Rs\.?|You paid\s+₹)\s*([\d,]+(?:\.\d{1,2})?)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            return float(match.group(1).replace(",", ""))
    return None


def _date(text: str) -> str:
    match = re.search(r"\b(\d{2})[- ]?(\d{2}|[A-Za-z]{3})[- ]?(\d{2,4})\b", text)
    if match:
        candidate = match.group(0)
        for fmt in ("%d-%m-%y", "%d-%b-%y", "%d%b%y", "%d %b %y", "%d-%m-%Y", "%d-%b-%Y"):
            try:
                return datetime.strptime(candidate, fmt).date().isoformat()
            except ValueError:
                pass
    return datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()


def _description(text: str) -> str:
    patterns = [r"towards\s+(.+?)(?:\.\s|\.\s*-SBI|$)", r"\bat\s+(.+?)(?:\.\s|\.\s*-|$)", r"\bto\s+(?:VPA\s+)?(.+?)(?:\s+(?:via|using)|\s*\(|\.|$)"]
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            return match.group(1).strip(" .;")
    return "Transaction"


def _category(description: str) -> str:
    lower = description.lower()
    for marker, category in MERCHANT_CATEGORIES.items():
        if marker in lower:
            return category
    return "Other"


async def _is_duplicate(db: aiosqlite.Connection, ledger_id: str, entry: dict[str, Any]) -> bool:
    cursor = await db.execute(
        """SELECT description FROM entries WHERE ledger_id = ? AND amount = ? AND txn_date = ?
           AND deleted_at IS NULL""",
        (ledger_id, entry["amount"], entry["txn_date"]),
    )
    return any(SequenceMatcher(None, row[0].lower(), entry["description"].lower()).ratio() >= 0.8 for row in await cursor.fetchall())


async def parse_transactions(db: aiosqlite.Connection, user_id: str, raw_text: str) -> dict[str, list[dict[str, Any]]]:
    ledger_id = ledger_id_for(user_id)
    await db.execute("DELETE FROM pending_entries WHERE created_at < datetime('now', '-24 hours')")
    await db.execute("DELETE FROM pending_entries WHERE user_id = ?", (user_id,))
    inserted: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    unknown_payees: list[str] = []
    dry_run = SAMPLE_UPI_REF in raw_text

    for chunk in split_sms(raw_text):
        amount = _amount(chunk)
        if amount is None:
            continue
        txn_type = "credit" if re.search(r"\bcredited\b", chunk, re.I) else "debit"
        description = _description(chunk)
        category = _category(description)
        entry = {"type": txn_type, "amount": amount, "category": category, "description": description, "txn_date": _date(chunk)}
        if dry_run:
            inserted.append({"id": None, **entry, "dry_run": True})
            continue
        if await _is_duplicate(db, ledger_id, entry):
            cursor = await db.execute(
                """INSERT INTO pending_entries (ledger_id, user_id, type, amount, category, description, txn_date, source, raw_input)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'sms', ?)""",
                (
                    ledger_id,
                    user_id,
                    entry["type"],
                    entry["amount"],
                    entry["category"],
                    entry["description"],
                    entry["txn_date"],
                    chunk,
                ),
            )
            pending.append({"pending_id": cursor.lastrowid, **entry})
            continue
        cursor = await db.execute(
            """INSERT INTO entries (ledger_id,user_id,paid_by,type,amount,category,description,txn_date,source,raw_input)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sms', ?)""",
            (
                ledger_id,
                user_id,
                user_id,
                entry["type"],
                entry["amount"],
                entry["category"],
                entry["description"],
                entry["txn_date"],
                chunk,
            ),
        )
        inserted.append({"id": cursor.lastrowid, **entry})
        if category == "Other" and txn_type == "debit" and re.search(r"\b(?:trf to|to)\s+[A-Z][A-Z ]+", chunk):
            unknown_payees.append(description)
    return {"inserted": inserted, "pending": pending, "unknown_payees": unknown_payees}


async def resolve_pending(db: aiosqlite.Connection, user_id: str, pending_ids: list[int], action: str) -> dict[str, int]:
    if action not in {"log", "discard"}:
        raise ValueError("action must be log or discard")
    placeholders = ",".join("?" for _ in pending_ids)
    if not placeholders:
        return {"resolved": 0}
    cursor = await db.execute(
        f"SELECT id, ledger_id, type, amount, category, description, txn_date, source, raw_input FROM pending_entries WHERE user_id = ? AND id IN ({placeholders})",
        [user_id, *pending_ids],
    )
    rows = await cursor.fetchall()
    if action == "log":
        for _, ledger_id, txn_type, amount, category, description, txn_date, source, raw_input in rows:
            await db.execute(
                "INSERT INTO entries (ledger_id,user_id,paid_by,type,amount,category,description,txn_date,source,raw_input) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (ledger_id, user_id, user_id, txn_type, amount, category, description, txn_date, source, raw_input),
            )
    await db.execute(f"DELETE FROM pending_entries WHERE user_id = ? AND id IN ({placeholders})", [user_id, *pending_ids])
    return {"resolved": len(rows)}
