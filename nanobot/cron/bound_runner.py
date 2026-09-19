"""Execution helpers for session-bound cron jobs."""

from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, Protocol

from nanobot.agent.tools.cron import CronTool
from nanobot.bus.events import OutboundMessage
from nanobot.cron.session_delivery import origin_delivery_context
from nanobot.cron.session_turns import (
    CRON_DEFER_UNTIL_IDLE_META,
    CRON_TRIGGER_META,
    cron_execution_session_key,
)
from nanobot.cron.types import CronJob, CronRunResult
from nanobot.cron.webui_metadata import cron_proactive_delivery_metadata
from nanobot.utils.prompt_templates import render_template

if TYPE_CHECKING:
    from nanobot.agent.tools.registry import ToolRegistry


class BoundCronAgent(Protocol):
    tools: ToolRegistry

    async def process_cron_turn(
        self,
        content: str,
        *,
        session_key: str,
        channel: str,
        chat_id: str,
        metadata: dict[str, Any],
    ) -> OutboundMessage | None:
        ...


class CronRunRecorder(Protocol):
    def write_run_record(self, run_id: str, record: dict[str, Any]) -> None:
        ...


CronResultDelivery = Callable[[OutboundMessage], Awaitable[None]]
CronActivityDelivery = Callable[[CronJob, bool], Awaitable[None]]


def _cron_prompt_ref(prompt: str) -> dict[str, Any]:
    return {
        "id": "cron.agent_turn.reminder",
        "version": 1,
        "sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
    }


def _bound_session_delivery_context(
    job: CronJob,
    *,
    turn_seed: str,
    source_label: str | None,
) -> tuple[str, str, dict[str, Any]]:
    channel, chat_id, metadata = origin_delivery_context(job)

    if channel == "websocket":
        metadata["webui"] = True
        metadata.update(
            cron_proactive_delivery_metadata(
                "websocket",
                metadata,
                turn_seed=turn_seed,
                source_label=source_label,
            )
        )

    return channel, chat_id, metadata


async def run_bound_cron_job(
    job: CronJob,
    *,
    agent: BoundCronAgent,
    cron: CronRunRecorder,
    deliver_result: CronResultDelivery,
    deliver_activity: CronActivityDelivery,
) -> CronRunResult:
    """Execute a session-bound cron job as a normal agent session turn."""
    if not job.payload.session_key:
        raise ValueError(f"cron job {job.id} is missing payload.session_key")
    session_key = cron_execution_session_key(job)

    prompt = render_template(
        "agent/cron_reminder.md",
        strip=True,
        message=job.payload.message,
    )
    prompt_ref = _cron_prompt_ref(prompt)
    run_id = f"{job.id}:{int(time.time() * 1000)}:{uuid.uuid4().hex[:8]}"
    channel, chat_id, metadata = _bound_session_delivery_context(
        job,
        turn_seed=f"cron:{job.id}",
        source_label=job.name,
    )
    metadata[CRON_TRIGGER_META] = {
        "job_id": job.id,
        "job_name": job.name,
        "run_id": run_id,
        "prompt_ref": prompt_ref,
        "persist_content": (
            f"Scheduled cron job triggered: {job.name}\n\n{job.payload.message}"
        ),
    }
    metadata[CRON_DEFER_UNTIL_IDLE_META] = True
    run_record_base: dict[str, Any] = {
        "job_id": job.id,
        "job_name": job.name,
        "session_key": session_key,
        "prompt_ref": prompt_ref,
        "prompt_vars": {"message": job.payload.message},
        "rendered_prompt": prompt,
    }

    cron.write_run_record(
        run_id,
        {
            **run_record_base,
            "status": "queued",
        },
    )

    cron_tool = agent.tools.get("cron")
    cron_token = None
    if isinstance(cron_tool, CronTool):
        cron_token = cron_tool.set_cron_context(True)
    await deliver_activity(job, True)
    try:
        resp = await agent.process_cron_turn(
            prompt,
            session_key=session_key,
            channel=channel,
            chat_id=chat_id,
            metadata=metadata,
        )
        response = resp.content if resp else ""
        if (
            resp is not None
            and response.strip().upper() != "NO_REPLY"
            and (response or resp.media)
        ):
            result_metadata = dict(metadata)
            result_metadata.update(resp.metadata)
            await deliver_result(OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content=response,
                media=list(resp.media),
                buttons=list(resp.buttons),
                metadata=result_metadata,
            ))
        cron.write_run_record(
            run_id,
            {
                **run_record_base,
                "status": "ok",
                "response": response,
            },
        )
        return CronRunResult(run_id=run_id, response=response)
    except (Exception, asyncio.CancelledError) as exc:
        error_text = str(exc) or exc.__class__.__name__
        cron.write_run_record(
            run_id,
            {
                **run_record_base,
                "status": "error",
                "error": error_text,
            },
        )
        raise
    finally:
        if isinstance(cron_tool, CronTool) and cron_token is not None:
            cron_tool.reset_cron_context(cron_token)
        await deliver_activity(job, False)
