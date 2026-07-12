"""Strict Responses API tool schemas and server-side dispatch."""

from __future__ import annotations

import json
from typing import Any

import aiosqlite

from xpensego.handlers.entries import (
    delete_last_entry,
    log_entries,
    purge_my_data,
    recategorize_entry,
)
from xpensego.handlers.budgets import manage_budget
from xpensego.handlers.parsing import parse_transactions, resolve_pending
from xpensego.handlers.queries import query_ledger

TOOLS = [
    {
        "type": "function",
        "name": "log_entries",
        "description": "Record one or more debit expenses or credit income entries the user stated. Resolve relative dates before calling.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "entries": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {"type": "string", "enum": ["debit", "credit"]},
                            "amount": {"type": "number", "exclusiveMinimum": 0},
                            "category": {"type": "string"},
                            "description": {"type": "string"},
                            "txn_date": {"type": "string"},
                            "payee": {"type": "string"},
                        },
                        "required": ["type", "amount", "category", "description", "txn_date", "payee"],
                        "additionalProperties": False,
                    },
                },
                "teach_payee": {
                    "anyOf": [
                        {
                            "type": "object",
                            "properties": {
                                "payee": {"type": "string"},
                                "category": {"type": "string"},
                            },
                            "required": ["payee", "category"],
                            "additionalProperties": False,
                        },
                        {"type": "null"},
                    ]
                },
            },
            "required": ["entries", "teach_payee"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "parse_transactions",
        "description": "Parse one or more pasted bank or UPI SMS messages. Call with the complete raw pasted text; inserted rows preserve raw text and duplicates are held for confirmation.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {"raw_text": {"type": "string"}},
            "required": ["raw_text"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "resolve_pending",
        "description": "Resolve duplicate parsed entries held for the caller after the caller says to log or skip them.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "pending_ids": {"type": "array", "items": {"type": "integer"}},
                "action": {"type": "string", "enum": ["log", "discard"]}
            },
            "required": ["pending_ids", "action"],
            "additionalProperties": False
        }
    },
    {
        "type": "function",
        "name": "query_ledger",
        "description": "Answer a money question using structured slots. The server scopes the query to the caller and writes no model SQL.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "metric": {"type": "string", "enum": ["total", "list", "max", "avg_per_day", "count", "budget_status"]},
                "type": {"type": "string", "enum": ["debit", "credit", "all"]},
                "category": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                "description_contains": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                "date_from": {"type": "string"}, "date_to": {"type": "string"},
                "compare_date_from": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                "compare_date_to": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                "group_by": {"type": "string", "enum": ["category", "txn_date", "none"]}
            },
            "required": ["metric", "type", "category", "description_contains", "date_from", "date_to", "compare_date_from", "compare_date_to", "group_by"],
            "additionalProperties": False
        }
    },
    {
        "type": "function",
        "name": "manage_budget",
        "description": "Set a monthly category budget or list the caller's budgets with month-to-date debit spend.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["set", "list"]},
                "category": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                "monthly_limit": {"anyOf": [{"type": "number", "exclusiveMinimum": 0}, {"type": "null"}]}
            },
            "required": ["action", "category", "monthly_limit"],
            "additionalProperties": False
        }
    },
    {
        "type": "function",
        "name": "delete_last_entry",
        "description": "Soft-delete the caller's newest live entry when they ask to delete the last entry.",
        "strict": True,
        "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
    },
    {
        "type": "function",
        "name": "recategorize_entry",
        "description": "Correct one of the caller's entries to one fixed category.",
        "strict": True,
        "parameters": {"type": "object", "properties": {"entry_id": {"type": "integer"}, "category": {"type": "string"}}, "required": ["entry_id", "category"], "additionalProperties": False},
    },
    {
        "type": "function",
        "name": "purge_my_data",
        "description": "Permanently delete all of the caller's data only after explicit confirmation in this conversation.",
        "strict": True,
        "parameters": {"type": "object", "properties": {"user_confirmed": {"type": "boolean", "enum": [True]}}, "required": ["user_confirmed"], "additionalProperties": False},
    },
]


async def dispatch_tool(
    db: aiosqlite.Connection, user_id: str, name: str, arguments: str
) -> str:
    try:
        payload = json.loads(arguments)
        if name == "log_entries":
            result = await log_entries(db, user_id, payload)
        elif name == "parse_transactions":
            result = await parse_transactions(db, user_id, payload["raw_text"])
        elif name == "resolve_pending":
            result = await resolve_pending(db, user_id, payload["pending_ids"], payload["action"])
        elif name == "query_ledger":
            result = await query_ledger(db, user_id, payload)
        elif name == "manage_budget":
            result = await manage_budget(db, user_id, payload)
        elif name == "delete_last_entry":
            result = await delete_last_entry(db, user_id)
        elif name == "recategorize_entry":
            result = await recategorize_entry(db, user_id, payload["entry_id"], payload["category"])
        elif name == "purge_my_data":
            if payload.get("user_confirmed") is not True:
                return json.dumps({"error": "explicit confirmation is required"})
            await purge_my_data(db, user_id)
            result = {"purged": True}
        else:
            return json.dumps({"error": f"unknown tool: {name}"})
        return json.dumps(result)
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        return json.dumps({"error": str(exc)})
