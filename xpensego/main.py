"""Coordinated local runtime: FastAPI admin API, APScheduler, and Telegram polling."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import uvicorn
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, HTTPException, Request

from xpensego.alerts import check_budget_alerts, format_alert, mark_alert_sent
from xpensego.config import Settings
from xpensego.db import get_connection, migrate
from xpensego.telegram.bot import build_application
from xpensego.telegram.send import send_message

settings: Settings | None = None
telegram_application = None
scheduler: AsyncIOScheduler | None = None


def get_settings() -> Settings:
    global settings
    if settings is None:
        settings = Settings.from_env()
    return settings


async def run_alert_check() -> list[dict]:
    active_settings = get_settings()
    async with get_connection(active_settings.db_path) as db:
        alerts = await check_budget_alerts(db, claim=False)
    delivered: list[dict] = []
    if telegram_application is None:
        return alerts
    for alert in alerts:
        recipient = alert["ledger_id"].removeprefix("user:")
        if not alert["ledger_id"].startswith("user:") or recipient == "0":
            continue
        try:
            await send_message(telegram_application, recipient, format_alert(alert))
        except Exception:
            continue
        async with get_connection(active_settings.db_path) as db:
            if await mark_alert_sent(db, alert):
                delivered.append(alert)
    return delivered


@asynccontextmanager
async def lifespan(_: FastAPI):
    active_settings = get_settings()
    await migrate(active_settings.db_path)
    yield


app = FastAPI(title="Xpensego", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/trigger-alerts")
async def trigger_alerts(request: Request) -> dict:
    if request.client and request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(status_code=403, detail="localhost only")
    alerts = await run_alert_check()
    return {"alerts": alerts, "count": len(alerts)}


async def serve() -> None:
    global telegram_application, scheduler
    active_settings = get_settings()
    await migrate(active_settings.db_path)
    telegram_application = build_application(active_settings)
    scheduler = AsyncIOScheduler(timezone="Asia/Kolkata")
    scheduler.add_job(run_alert_check, "cron", hour=active_settings.alert_hour_ist, minute=0, id="budget-alerts")

    await telegram_application.initialize()
    await telegram_application.start()
    await telegram_application.updater.start_polling(allowed_updates=["message", "callback_query"])
    scheduler.start()  # Called inside this running asyncio event loop.
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=8000, log_level="info"))
    try:
        await server.serve()
    finally:
        if scheduler.running:
            scheduler.shutdown(wait=False)
        await telegram_application.updater.stop()
        await telegram_application.stop()
        await telegram_application.shutdown()


def main() -> None:
    asyncio.run(serve())


if __name__ == "__main__":
    main()
