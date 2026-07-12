"""Application entrypoint for local buildathon polling."""

from __future__ import annotations

import asyncio

from fastapi import FastAPI

from xpensego.config import Settings
from xpensego.db import migrate
from xpensego.telegram.bot import build_application

app = FastAPI(title="Xpensego")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def main() -> None:
    settings = Settings.from_env()
    asyncio.run(migrate(settings.db_path))
    build_application(settings).run_polling(allowed_updates=["message"])


if __name__ == "__main__":
    main()
