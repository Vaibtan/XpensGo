"""OpenAI Responses API wrapper with mandatory cost-log writes."""

from __future__ import annotations

from typing import Any

import aiosqlite
from openai import AsyncOpenAI

MODEL = "gpt-5.4-nano"
# Kept as zero until a verified price for this locked buildathon model is configured.
# The token counts remain durable, allowing historical cost recomputation.
INPUT_USD_PER_TOKEN = 0.0
OUTPUT_USD_PER_TOKEN = 0.0


async def create_response(
    client: AsyncOpenAI,
    db: aiosqlite.Connection,
    user_id: str | None,
    operation: str,
    **kwargs: Any,
) -> Any:
    input_tokens = 0
    output_tokens = 0
    try:
        response = await client.responses.create(model=MODEL, **kwargs)
        usage = response.usage
        input_tokens = getattr(usage, "input_tokens", 0) or 0
        output_tokens = getattr(usage, "output_tokens", 0) or 0
        return response
    finally:
        await db.execute(
            """
            INSERT INTO cost_log (user_id, operation, model, input_tokens, output_tokens, cost_usd)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                operation,
                MODEL,
                input_tokens,
                output_tokens,
                input_tokens * INPUT_USD_PER_TOKEN + output_tokens * OUTPUT_USD_PER_TOKEN,
            ),
        )
