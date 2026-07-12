"""Runtime configuration loaded exclusively from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    telegram_bot_token: str
    openai_api_key: str
    db_path: Path
    alert_hour_ist: int = 20
    bot_paused: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        # Keep explicit environment variables authoritative, while making the local .env
        # workflow work without requiring callers to source the file manually.
        load_dotenv(dotenv_path=Path.cwd() / ".env", override=False)
        telegram_bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
        openai_api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if not telegram_bot_token:
            raise RuntimeError("TELEGRAM_BOT_TOKEN must be set")
        if not openai_api_key:
            raise RuntimeError("OPENAI_API_KEY must be set")

        try:
            alert_hour_ist = int(os.getenv("ALERT_HOUR_IST", "20"))
        except ValueError as exc:
            raise RuntimeError("ALERT_HOUR_IST must be an integer from 0 to 23") from exc
        if not 0 <= alert_hour_ist <= 23:
            raise RuntimeError("ALERT_HOUR_IST must be an integer from 0 to 23")

        return cls(
            telegram_bot_token=telegram_bot_token,
            openai_api_key=openai_api_key,
            db_path=Path(os.getenv("DB_PATH", "./xpensego.db")),
            alert_hour_ist=alert_hour_ist,
            bot_paused=os.getenv("BOT_PAUSED", "false").lower() in {"1", "true", "yes"},
        )
