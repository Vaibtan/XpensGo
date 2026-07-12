"""Per-message OpenAI Responses API tool loop."""

from __future__ import annotations

from typing import Any

from openai import AsyncOpenAI

from xpensego.agent.system_prompt import build_system_prompt
from xpensego.agent.tools import TOOLS, dispatch_tool
from xpensego.costs import create_response
from xpensego.db import append_context, get_connection, load_context

MAX_TOOL_ITERATIONS = 8


async def process_message(client: AsyncOpenAI, db_path: Any, user_id: str, text: str) -> str:
    """Run an isolated agent turn and persist only this user's conversation context."""
    text = text[:4000]
    async with get_connection(db_path) as db:
        system = await build_system_prompt(db, user_id)
        context = await load_context(db, user_id)
        response = await create_response(
            client,
            db,
            user_id,
            "agent_turn",
            input=[
                {"role": "system", "content": system},
                *({"role": role, "content": content} for role, content in context),
                {"role": "user", "content": text},
            ],
            tools=TOOLS,
        )

        for _ in range(MAX_TOOL_ITERATIONS):
            calls = [item for item in response.output if item.type == "function_call"]
            if not calls:
                reply = response.output_text.strip() or "I couldn't complete that. Please try again."
                await append_context(db, user_id, text, reply)
                return reply
            outputs = []
            for call in calls:
                output = await dispatch_tool(db, user_id, call.name, call.arguments)
                outputs.append({"type": "function_call_output", "call_id": call.call_id, "output": output})
            response = await create_response(
                client,
                db,
                user_id,
                "agent_turn",
                previous_response_id=response.id,
                input=outputs,
                tools=TOOLS,
            )

        reply = "Please simplify that request and try again."
        await append_context(db, user_id, text, reply)
        return reply
