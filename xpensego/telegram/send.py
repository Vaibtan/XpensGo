"""Outbound Telegram delivery used by proactive alert jobs."""

from __future__ import annotations

from telegram.ext import Application


async def send_message(application: Application, user_id: str, text: str) -> None:
    await application.bot.send_message(chat_id=int(user_id), text=text)
