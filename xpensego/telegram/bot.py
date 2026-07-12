"""Telegram polling transport. Identity is sourced only from Telegram updates."""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from openai import AsyncOpenAI
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

from xpensego.agent.loop import process_message
from xpensego.config import Settings
from xpensego.db import allowed_agent_turn, get_connection, upsert_user
from xpensego.handlers.parsing import parse_csv_statement


async def _upsert_sender(update: Update, settings: Settings) -> str | None:
    sender = update.effective_user
    if sender is None:
        return None
    display_name = " ".join(part for part in [sender.first_name, sender.last_name] if part) or None
    async with get_connection(settings.db_path) as db:
        await upsert_user(db, str(sender.id), display_name)
    return str(sender.id)


async def _maintenance_if_paused(update: Update, settings: Settings) -> bool:
    if not settings.bot_paused:
        return False
    if update.effective_message:
        await update.effective_message.reply_text(
            "Xpensego is temporarily under maintenance. Please try again soon."
        )
    return True


async def _is_onboarded(settings: Settings, user_id: str) -> bool:
    async with get_connection(settings.db_path) as db:
        cursor = await db.execute("SELECT onboarded_at FROM users WHERE user_id = ?", (user_id,))
        row = await cursor.fetchone()
        return bool(row and row[0])


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    settings: Settings = context.application.bot_data["settings"]
    if await _maintenance_if_paused(update, settings):
        return
    await _upsert_sender(update, settings)
    if update.effective_message:
        sample_date = (datetime.now(ZoneInfo("Asia/Kolkata")).date() - timedelta(days=1)).strftime("%d-%m-%y")
        await update.effective_message.reply_text(
            "Hi, I'm Xpensego. Tell me what you spend, or paste your bank SMS — I'll keep the ledger and answer anything about your money."
        )
        await update.effective_message.reply_text(
            "Try it — paste this: `HDFC Bank: Rs.649.00 debited from a/c **1234 on "
            f"{sample_date} to VPA blinkit@ybl (UPI Ref 000000424242)`"
        )


async def ping(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    settings: Settings = context.application.bot_data["settings"]
    if await _maintenance_if_paused(update, settings):
        return
    await _upsert_sender(update, settings)
    if update.effective_message:
        await update.effective_message.reply_text("pong")


async def csv_document(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    settings: Settings = context.application.bot_data["settings"]
    if await _maintenance_if_paused(update, settings):
        return
    user_id = await _upsert_sender(update, settings)
    document = update.effective_message.document if update.effective_message else None
    if user_id is None or document is None:
        return
    if document.file_size and document.file_size > 1024 * 1024:
        await update.effective_message.reply_text("That CSV is over the 1 MB limit. Please send a smaller statement.")
        return
    file = await document.get_file()
    data = bytes(await file.download_as_bytearray())
    async with get_connection(settings.db_path) as db:
        result = await parse_csv_statement(db, user_id, data)
    if result.get("status") == "needs_clarification":
        await update.effective_message.reply_text(result["needs_clarification"]["message"])
        return
    inserted = result.get("inserted", [])
    total = sum(item["amount"] for item in inserted if item["type"] == "debit")
    await update.effective_message.reply_text(
        f"✓ Parsed {len(inserted)} entries · ₹{total:,.0f} debits. Reply with a number to fix a category."
    )


async def text_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    settings: Settings = context.application.bot_data["settings"]
    if await _maintenance_if_paused(update, settings):
        return
    user_id = await _upsert_sender(update, settings)
    if not update.effective_message or user_id is None:
        return

    text = (update.effective_message.text or "")[:4000]
    if text.strip().lower() == "ping":
        await update.effective_message.reply_text("pong")
        return
    async with get_connection(settings.db_path) as db:
        if not await allowed_agent_turn(db, user_id):
            await update.effective_message.reply_text(
                "You've reached the message limit for now. Please try again later."
            )
            return

    was_onboarded = await _is_onboarded(settings, user_id)
    client: AsyncOpenAI = context.application.bot_data["openai_client"]
    reply = await process_message(client, settings.db_path, user_id, text)
    await update.effective_message.reply_text(reply)
    if not was_onboarded and await _is_onboarded(settings, user_id):
        await update.effective_message.reply_text(
            "That's it. Log something real, or set a budget anytime — like *food budget 5000*."
        )


def build_application(settings: Settings) -> Application:
    application = Application.builder().token(settings.telegram_bot_token).build()
    application.bot_data["settings"] = settings
    application.bot_data["openai_client"] = AsyncOpenAI(api_key=settings.openai_api_key)
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("ping", ping))
    application.add_handler(MessageHandler(filters.Document.FileExtension("csv"), csv_document))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_message))
    return application
