"""Read-only, server-scoped ledger queries for structured agent tool calls."""

from __future__ import annotations

from datetime import date
from typing import Any, Mapping

import aiosqlite

from xpensego.handlers.entries import ledger_id_for

_METRICS = frozenset({"total", "list", "max", "avg_per_day", "count", "budget_status"})
_ENTRY_TYPES = frozenset({"debit", "credit", "all"})
_GROUP_COLUMNS = {"category": "category", "txn_date": "txn_date"}


def _date_slot(slots: Mapping[str, Any], name: str) -> str:
    value = slots.get(name)
    if not isinstance(value, str):
        raise ValueError(f"{name} is required and must be YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be YYYY-MM-DD") from exc
    return value


def _entry_filters(
    ledger_id: str,
    entry_type: str,
    slots: Mapping[str, Any],
    date_from: str,
    date_to: str,
    *,
    alias: str = "",
) -> tuple[list[str], list[Any]]:
    """Return only fixed SQL fragments plus bound values for live tenant entries."""
    prefix = f"{alias}." if alias else ""
    conditions = [
        f"{prefix}ledger_id = ?",
        f"{prefix}deleted_at IS NULL",
        f"{prefix}txn_date >= ?",
        f"{prefix}txn_date <= ?",
    ]
    params: list[Any] = [ledger_id, date_from, date_to]

    if entry_type != "all":
        conditions.append(f"{prefix}type = ?")
        params.append(entry_type)

    category = slots.get("category")
    if category is not None:
        if not isinstance(category, str) or not category:
            raise ValueError("category must be a non-empty string")
        conditions.append(f"{prefix}category = ?")
        params.append(category)

    description_contains = slots.get("description_contains")
    if description_contains is not None:
        if not isinstance(description_contains, str):
            raise ValueError("description_contains must be a string")
        conditions.append(f"{prefix}description LIKE ? COLLATE NOCASE")
        params.append(f"%{description_contains}%")

    return conditions, params


async def _query_metric(
    db: aiosqlite.Connection,
    metric: str,
    ledger_id: str,
    entry_type: str,
    slots: Mapping[str, Any],
    date_from: str,
    date_to: str,
) -> dict[str, Any]:
    conditions, params = _entry_filters(ledger_id, entry_type, slots, date_from, date_to)
    where = " AND ".join(conditions)

    if metric == "total":
        group_by = slots.get("group_by", "none")
        if group_by not in {"none", *(_GROUP_COLUMNS.keys())}:
            raise ValueError("group_by must be category, txn_date, or none")
        if group_by == "none":
            cursor = await db.execute(f"SELECT COALESCE(SUM(amount), 0) FROM entries WHERE {where}", params)
            total = float((await cursor.fetchone())[0])
            return {"total": total}

        column = _GROUP_COLUMNS[group_by]
        cursor = await db.execute(
            f"""
            SELECT {column}, COALESCE(SUM(amount), 0)
            FROM entries
            WHERE {where}
            GROUP BY {column}
            ORDER BY {column}
            """,
            params,
        )
        return {
            "groups": [
                {group_by: row[0], "total": float(row[1])} for row in await cursor.fetchall()
            ]
        }

    if metric == "list":
        cursor = await db.execute(
            f"""
            SELECT id, type, amount, category, description, txn_date
            FROM entries
            WHERE {where}
            ORDER BY txn_date DESC, id DESC
            LIMIT ?
            """,
            [*params, 200],
        )
        rows = await cursor.fetchall()
        return {
            "entries": [
                {
                    "id": row[0],
                    "type": row[1],
                    "amount": float(row[2]),
                    "category": row[3],
                    "description": row[4],
                    "txn_date": row[5],
                }
                for row in rows
            ]
        }

    if metric == "max":
        cursor = await db.execute(
            f"""
            SELECT id, type, amount, category, description, txn_date
            FROM entries
            WHERE {where}
            ORDER BY amount DESC, txn_date DESC, id DESC
            LIMIT 1
            """,
            params,
        )
        row = await cursor.fetchone()
        if row is None:
            return {"entry": None}
        return {
            "entry": {
                "id": row[0],
                "type": row[1],
                "amount": float(row[2]),
                "category": row[3],
                "description": row[4],
                "txn_date": row[5],
            }
        }

    if metric == "avg_per_day":
        cursor = await db.execute(f"SELECT COALESCE(SUM(amount), 0) FROM entries WHERE {where}", params)
        total = float((await cursor.fetchone())[0])
        days = (date.fromisoformat(date_to) - date.fromisoformat(date_from)).days + 1
        return {"total": total, "days": days, "avg_per_day": total / days}

    if metric == "count":
        cursor = await db.execute(f"SELECT COUNT(*) FROM entries WHERE {where}", params)
        return {"count": int((await cursor.fetchone())[0])}

    # Budget status is always debit spend, regardless of a model-supplied entry type.
    budget_conditions, budget_params = _entry_filters(
        ledger_id, "debit", slots, date_from, date_to, alias="e"
    )
    on_clause = " AND ".join(["b.category = e.category", *budget_conditions])
    budget_where = ["b.ledger_id = ?"]
    budget_where_params: list[Any] = [ledger_id]
    if slots.get("category") is not None:
        budget_where.append("b.category = ?")
        budget_where_params.append(slots["category"])

    cursor = await db.execute(
        f"""
        SELECT b.category, b.monthly_limit, COALESCE(SUM(e.amount), 0)
        FROM budgets AS b
        LEFT JOIN entries AS e ON {on_clause}
        WHERE {' AND '.join(budget_where)}
        GROUP BY b.category, b.monthly_limit
        ORDER BY b.category
        """,
        [*budget_params, *budget_where_params],
    )
    budgets = []
    for category, monthly_limit, spent in await cursor.fetchall():
        limit = float(monthly_limit)
        spent_amount = float(spent)
        budgets.append(
            {
                "category": category,
                "monthly_limit": limit,
                "spent": spent_amount,
                "remaining": limit - spent_amount,
                "percent_used": (spent_amount / limit) * 100,
            }
        )
    return {"budgets": budgets}


async def query_ledger(
    db: aiosqlite.Connection, user_id: str, slots: Mapping[str, Any]
) -> dict[str, Any]:
    """Execute a fixed, parameterized ledger query under the authenticated user's scope."""
    metric = slots.get("metric")
    if metric not in _METRICS:
        raise ValueError(f"unsupported metric: {metric}")

    entry_type = slots.get("type", "debit")
    if entry_type not in _ENTRY_TYPES:
        raise ValueError(f"unsupported entry type: {entry_type}")

    date_from = _date_slot(slots, "date_from")
    date_to = _date_slot(slots, "date_to")
    if date_from > date_to:
        raise ValueError("date_from must not be after date_to")

    compare_from = slots.get("compare_date_from")
    compare_to = slots.get("compare_date_to")
    if (compare_from is None) != (compare_to is None):
        raise ValueError("compare_date_from and compare_date_to must be set together")
    if compare_from is not None:
        compare_from = _date_slot(slots, "compare_date_from")
        compare_to = _date_slot(slots, "compare_date_to")
        if compare_from > compare_to:
            raise ValueError("compare_date_from must not be after compare_date_to")

    # Never read any ledger or user identifier from model-provided slots.
    ledger_id = ledger_id_for(user_id)
    effective_type = "debit" if metric == "budget_status" else entry_type
    result: dict[str, Any] = {
        "metric": metric,
        "type": effective_type,
        "date_from": date_from,
        "date_to": date_to,
    }
    result.update(
        await _query_metric(db, metric, ledger_id, effective_type, slots, date_from, date_to)
    )

    if compare_from is not None and compare_to is not None:
        comparison = {
            "date_from": compare_from,
            "date_to": compare_to,
        }
        comparison.update(
            await _query_metric(
                db, metric, ledger_id, effective_type, slots, compare_from, compare_to
            )
        )
        result["comparison"] = comparison

    return result
