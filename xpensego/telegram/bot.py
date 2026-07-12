"""Telegram polling transport. Identity is sourced only from Telegram updates."""

from __future__ import annotations

from openai import AsyncOpenAI
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

from xpensego.agent.loop import process_message
from xpensego.config import Settings
from xpensego.db import allowed_agent_turn, get_connection, upsert_user


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


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    settings: Settings = context.application.bot_data["settings"]
    if await _maintenance_if_paused(update, settings):
        return
    await _upsert_sender(update, settings)
    if update.effective_message:
        await update.effective_message.reply_text("Xpensego is getting ready. Send ping to verify the bot.")


async def ping(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    settings: Settings = context.application.bot_data["settings"]
    if await _maintenance_if_paused(update, settings):
        return
    await _upsert_sender(update, settings)
    if update.effective_message:
        await update.effective_message.reply_text("pong")


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

    client: AsyncOpenAI = context.application.bot_data["openai_client"]
    reply = await process_message(client, settings.db_path, user_id, text)
    await update.effective_message.reply_text(reply)


def build_application(settings: Settings) -> Application:
    application = Application.builder().token(settings.telegram_bot_token).build()
    application.bot_data["settings"] = settings
    application.bot_data["openai_client"] = AsyncOpenAI(api_key=settings.openai_api_key)
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("ping", ping))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_message))
    return application
