import asyncio

from xpensego.config import Settings
from xpensego.db import REQUIRED_TABLES, get_connection, migrate, upsert_user


def test_settings_load_required_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "telegram-token")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "xpensego.db"))
    monkeypatch.setenv("ALERT_HOUR_IST", "21")

    settings = Settings.from_env()

    assert settings.telegram_bot_token == "telegram-token"
    assert settings.openai_api_key == "openai-key"
    assert settings.db_path == tmp_path / "xpensego.db"
    assert settings.alert_hour_ist == 21


def test_migration_creates_full_schema_and_users_are_isolated(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            tables = {
                row[0]
                async for row in await db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            assert REQUIRED_TABLES <= tables

            await upsert_user(db, "telegram-user-a", "Asha")
            await upsert_user(db, "telegram-user-b", "Bharat")
            cursor = await db.execute("SELECT user_id, display_name FROM users ORDER BY user_id")
            assert await cursor.fetchall() == [
                ("telegram-user-a", "Asha"),
                ("telegram-user-b", "Bharat"),
            ]

    asyncio.run(exercise())
