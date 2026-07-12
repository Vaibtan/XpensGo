"""Local buildathon entrypoint: FastAPI admin endpoint, alert scheduler, Telegram polling."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, HTTPException, Request

from xpensego.alerts import check_budget_alerts, format_alert
from xpensego.config import Settings
from xpensego.db import get_connection, migrate
from xpensego.telegram.bot import build_application
from xpensego.telegram.send import send_message

settings: Settings | None = None
telegram_application = None
scheduler = AsyncIOScheduler(timezone="Asia/Kolkata")


async def run_alert_check() -> list[dict]:
    if settings is None:
        raise RuntimeError("application settings are not initialized")
    async with get_connection(settings.db_path) as db:
        alerts = await check_budget_alerts(db)
    if telegram_application is not None:
        for alert in alerts:
            if alert["ledger_id"].startswith("user:"):
                await send_message(telegram_application, alert["ledger_id"].removeprefix("user:"), format_alert(alert))
    return alerts


@asynccontextmanager
async def lifespan(_: FastAPI):
    global settings
    if settings is not None:
        await migrate(settings.db_path)
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


def main() -> None:
    global settings, telegram_application
    settings = Settings.from_env()
    asyncio.run(migrate(settings.db_path))
    telegram_application = build_application(settings)
    scheduler.add_job(run_alert_check, "cron", hour=settings.alert_hour_ist, minute=0, id="budget-alerts", replace_existing=True)
    scheduler.start()
    telegram_application.run_polling(allowed_updates=["message", "callback_query"])


if __name__ == "__main__":
    main()
