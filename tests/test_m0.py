import asyncio
from types import SimpleNamespace

from xpensego.config import Settings
from xpensego.db import get_connection, migrate, upsert_user
from xpensego.telegram.bot import ping, start, text_message

EXPECTED_TABLES = {
    "users", "entries", "pending_entries", "budgets", "payee_memory", "custom_categories",
    "conversation_context", "alerts_sent", "cost_log",
}


class FakeMessage:
    def __init__(self, text=""):
        self.text = text
        self.replies = []

    async def reply_text(self, text):
        self.replies.append(text)


def make_update(user_id, message):
    return SimpleNamespace(
        effective_user=SimpleNamespace(id=user_id, first_name="Test", last_name="User"),
        effective_message=message,
    )


def make_context(settings):
    return SimpleNamespace(application=SimpleNamespace(bot_data={"settings": settings}))


def test_settings_loads_shell_style_dotenv_file(monkeypatch, tmp_path):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text(
        "TELEGRAM_BOT_TOKEN=from-dotenv\nOPENAI_API_KEY=dotenv-key\nDB_PATH=dotenv.db\n",
        encoding="utf-8",
    )

    settings = Settings.from_env()

    assert settings.telegram_bot_token == "from-dotenv"
    assert settings.openai_api_key == "dotenv-key"
    assert settings.db_path.name == "dotenv.db"


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


def test_migration_creates_schema_contract_and_users_are_isolated(tmp_path):
    async def exercise():
        db_path = tmp_path / "xpensego.db"
        await migrate(db_path)
        async with get_connection(db_path) as db:
            tables = {row[0] async for row in await db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert EXPECTED_TABLES <= tables
            entries_columns = {row[1] async for row in await db.execute("PRAGMA table_info(entries)")}
            assert {"ledger_id", "user_id", "paid_by", "type", "amount", "deleted_at", "raw_input"} <= entries_columns
            await upsert_user(db, "telegram-user-a", "Asha")
            await upsert_user(db, "telegram-user-b", "Bharat")
            cursor = await db.execute("SELECT user_id, display_name FROM users ORDER BY user_id")
            assert await cursor.fetchall() == [("telegram-user-a", "Asha"), ("telegram-user-b", "Bharat")]
    asyncio.run(exercise())


def test_start_sends_fixed_welcome_and_dry_run_sample(tmp_path):
    async def exercise():
        settings = Settings("telegram", "openai", tmp_path / "xpensego.db")
        await migrate(settings.db_path)
        message = FakeMessage("/start")
        await start(make_update("fresh-user", message), make_context(settings))
        assert len(message.replies) == 2
        assert message.replies[0].startswith("Hi, I'm Xpensego 👋")
        assert "000000424242" in message.replies[1]
    asyncio.run(exercise())


def test_paused_bot_returns_maintenance_response_for_start_ping_and_text(tmp_path):
    async def exercise():
        settings = Settings("telegram", "openai", tmp_path / "xpensego.db", bot_paused=True)
        await migrate(settings.db_path)
        context = make_context(settings)
        for handler, text in ((start, "/start"), (ping, "/ping"), (text_message, "ping")):
            message = FakeMessage(text)
            await handler(make_update("42", message), context)
            assert message.replies == ["Xpensego is temporarily under maintenance. Please try again soon."]
    asyncio.run(exercise())
