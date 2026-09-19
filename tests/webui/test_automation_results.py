from pathlib import Path

import pytest

from nanobot.agent.tools.registry import ToolRegistry
from nanobot.bus.events import OutboundMessage
from nanobot.cron.bound_runner import run_bound_cron_job
from nanobot.cron.service import CronService
from nanobot.cron.types import CronJob, CronPayload, CronRunRecord, CronRunResult, CronSchedule
from nanobot.triggers.local_types import LocalTrigger, TriggerRunRecord
from nanobot.utils.run_records import write_run_record
from nanobot.webui.automation_results import cron_run_response, trigger_run_response


def job_with_run(run: CronRunRecord) -> CronJob:
    job = CronJob(id="job-1", name="Reminder", schedule=CronSchedule(kind="every", every_ms=60000),
                  payload=CronPayload(message="private prompt", session_key="websocket:one"))
    job.state.run_history = [run]
    return job


def write_result(path: Path, run_id: str, **changes: object) -> None:
    write_run_record(path, run_id, {
        "job_id": "job-1", "session_key": "websocket:one", "status": "ok",
        "response": "The selected response", "rendered_prompt": "private prompt", **changes,
    })


def test_reads_explicit_identity_not_the_latest_run(tmp_path: Path) -> None:
    run = CronRunRecord(run_at_ms=1000, status="ok", duration_ms=100, run_id="job-1:1001:one")
    job = job_with_run(run)
    write_result(tmp_path, run.run_id)
    write_result(tmp_path, "job-1:2001:two", response="The latest response")
    assert cron_run_response(tmp_path, job, run) == "The selected response"


@pytest.mark.parametrize("changes", [
    {"job_id": "other"}, {"session_key": "websocket:other"}, {"status": "error"},
    {"response": {"secret": "not text"}},
])
def test_validates_result_identity_and_response(tmp_path: Path, changes: dict[str, object]) -> None:
    run = CronRunRecord(1000, "ok", 100, run_id="job-1:1001:one")
    write_result(tmp_path, "job-1:1001:one", **changes)
    assert cron_run_response(tmp_path, job_with_run(run), run) is None


def test_legacy_lookup_is_unique_and_confined_to_the_execution_interval(tmp_path: Path) -> None:
    run = CronRunRecord(1000, "ok", 100)
    job = job_with_run(run)
    write_result(tmp_path, "job-1:900:old", response="old")
    write_result(tmp_path, "job-1:1002:one")
    write_result(tmp_path, "job-1:1200:later", response="later")
    assert cron_run_response(tmp_path, job, run) == "The selected response"
    write_result(tmp_path, "job-1:1003:ambiguous", response="different")
    assert cron_run_response(tmp_path, job, run) is None


def test_overlapping_history_does_not_borrow_another_runs_output(tmp_path: Path) -> None:
    run = CronRunRecord(1000, "ok", 100)
    job = job_with_run(run)
    job.state.run_history.append(CronRunRecord(1001, "ok", 99))
    write_result(tmp_path, "job-1:1002:other")
    assert cron_run_response(tmp_path, job, run) is None


def test_missing_record_is_distinct_from_empty_response(tmp_path: Path) -> None:
    run = CronRunRecord(1000, "ok", 100, run_id="job-1:1001:one")
    job = job_with_run(run)
    assert cron_run_response(tmp_path, job, run) is None
    write_result(tmp_path, "job-1:1001:one", response="")
    assert cron_run_response(tmp_path, job, run) == ""


def test_result_path_cannot_escape_the_runs_directory(tmp_path: Path) -> None:
    run = CronRunRecord(1000, "ok", 100, run_id="../private")
    runs = tmp_path / "runs"
    runs.mkdir()
    write_result(tmp_path, "private", response="outside")
    assert cron_run_response(runs, job_with_run(run), run) is None
    (runs / "broken.json").write_text("{", encoding="utf-8")
    run.run_id = "broken"
    assert cron_run_response(runs, job_with_run(run), run) is None


def test_local_trigger_uses_exact_delivery_time_and_session(tmp_path: Path) -> None:
    trigger = LocalTrigger("trg_one", "Reminder", True, "websocket", "one", "websocket:one")
    run = TriggerRunRecord(1000, "ok")
    for run_id, created, response in [("delivery-one", 1000, "first"), ("delivery-two", 2000, "latest")]:
        write_run_record(tmp_path, run_id, {
            "trigger_id": trigger.id, "session_key": trigger.session_key,
            "created_at_ms": created, "status": "ok", "response": response,
        })
    assert trigger_run_response(tmp_path, trigger, run) == "first"
    trigger.session_key = "websocket:other"
    assert trigger_run_response(tmp_path, trigger, run) is None


async def test_new_cron_run_identity_survives_reload(tmp_path: Path) -> None:
    seen: dict[str, object] = {}

    class Agent:
        tools = ToolRegistry()

        async def process_cron_turn(self, _content: str, **kwargs: object) -> OutboundMessage:
            seen["process"] = kwargs
            return OutboundMessage(channel="cli", chat_id="cron:job-1", content="reply")

    async def execute(job: CronJob) -> CronRunResult:
        return await run_bound_cron_job(
            job,
            agent=Agent(),
            cron=service,
            deliver_result=deliver,
            deliver_activity=activity,
        )

    async def deliver(msg: OutboundMessage) -> None:
        seen["delivery"] = msg

    async def activity(_job: CronJob, active: bool) -> None:
        seen.setdefault("activity", []).append(active)

    service = CronService(tmp_path / "jobs.json", on_job=execute)
    job = service.add_job(name="Reminder", schedule=CronSchedule(kind="every", every_ms=60000),
                          message="hi", session_key="websocket:one", origin_channel="websocket",
                          origin_chat_id="one", origin_metadata={
                              "workspace_scope": {"project_path": "/tmp/project"},
                          })
    assert await service.run_job(job.id, force=True)
    reloaded = CronService(tmp_path / "jobs.json").get_job(job.id)
    assert reloaded is not None
    record = reloaded.state.run_history[-1]
    assert record.run_id is not None
    assert cron_run_response(tmp_path / "runs", reloaded, record) == "reply"
    process = seen["process"]
    assert isinstance(process, dict)
    assert process["session_key"] == f"cron:{job.id}"
    assert process["channel"] == "websocket"
    assert process["chat_id"] == "one"
    assert process["metadata"]["workspace_scope"] == {"project_path": "/tmp/project"}
    delivery = seen["delivery"]
    assert isinstance(delivery, OutboundMessage)
    assert (delivery.channel, delivery.chat_id, delivery.content) == ("websocket", "one", "reply")
    assert delivery.metadata["_webui_message_source"] == {"kind": "cron", "label": "Reminder"}
    assert seen["activity"] == [True, False]
    assert CronRunRecord.from_store_dict({"runAtMs": 1000, "status": "ok", "runId": 42}).run_id is None


async def test_bound_cron_delivers_one_final_message_with_voice_metadata() -> None:
    delivered: list[OutboundMessage] = []
    records: list[dict[str, object]] = []

    class Agent:
        tools = ToolRegistry()

        async def process_cron_turn(self, _content: str, **kwargs: object) -> OutboundMessage:
            metadata = dict(kwargs["metadata"])
            metadata["voice"] = {"audioId": "morning", "path": "/media/morning.mp3"}
            return OutboundMessage(
                channel="websocket",
                chat_id="desktop",
                content="## Morning\n\n![photo](/media/morning.webp)",
                metadata=metadata,
            )

    class Recorder:
        def write_run_record(self, _run_id: str, record: dict[str, object]) -> None:
            records.append(record)

    async def deliver(msg: OutboundMessage) -> None:
        delivered.append(msg)

    async def activity(_job: CronJob, _active: bool) -> None:
        return None

    job = CronJob(
        id="job-1",
        name="Morning report",
        payload=CronPayload(
            message="return one markdown report",
            session_key="cron:job-1",
            origin_channel="websocket",
            origin_chat_id="desktop",
        ),
    )

    result = await run_bound_cron_job(
        job,
        agent=Agent(),
        cron=Recorder(),
        deliver_result=deliver,
        deliver_activity=activity,
    )

    assert result.response == "## Morning\n\n![photo](/media/morning.webp)"
    assert len(delivered) == 1
    assert delivered[0].metadata["_webui_message_source"] == {
        "kind": "cron", "label": "Morning report",
    }
    assert delivered[0].metadata["voice"]["audioId"] == "morning"
    assert delivered[0].metadata["webui_turn_id"].startswith("cron:job-1:")
    assert records[-1]["status"] == "ok"


@pytest.mark.parametrize("response", ["NO_REPLY", " no_reply\n"])
async def test_bound_cron_silent_response_is_recorded_without_delivery(response: str) -> None:
    delivered: list[OutboundMessage] = []
    records: list[dict[str, object]] = []

    class Agent:
        tools = ToolRegistry()

        async def process_cron_turn(self, _content: str, **_kwargs: object) -> OutboundMessage:
            return OutboundMessage(channel="websocket", chat_id="desktop", content=response)

    class Recorder:
        def write_run_record(self, _run_id: str, record: dict[str, object]) -> None:
            records.append(record)

    async def activity(_job: CronJob, _active: bool) -> None:
        return None

    async def deliver(msg: OutboundMessage) -> None:
        delivered.append(msg)

    result = await run_bound_cron_job(
        CronJob(id="job-1", name="Silent", payload=CronPayload(
            message="stay silent", session_key="cron:job-1",
            origin_channel="websocket", origin_chat_id="desktop",
        )),
        agent=Agent(),
        cron=Recorder(),
        deliver_result=deliver,
        deliver_activity=activity,
    )

    assert result.response == response
    assert delivered == []
    assert records[-1]["status"] == "ok"


async def test_bound_cron_delivery_failure_records_error() -> None:
    records: list[dict[str, object]] = []

    class Agent:
        tools = ToolRegistry()

        async def process_cron_turn(self, _content: str, **_kwargs: object) -> OutboundMessage:
            return OutboundMessage(channel="websocket", chat_id="desktop", content="result")

    class Recorder:
        def write_run_record(self, _run_id: str, record: dict[str, object]) -> None:
            records.append(record)

    async def fail_delivery(_msg: OutboundMessage) -> None:
        raise OSError("delivery failed")

    async def activity(_job: CronJob, _active: bool) -> None:
        return None

    with pytest.raises(OSError, match="delivery failed"):
        await run_bound_cron_job(
            CronJob(id="job-1", name="Failure", payload=CronPayload(
                message="report", session_key="cron:job-1",
                origin_channel="websocket", origin_chat_id="desktop",
            )),
            agent=Agent(),
            cron=Recorder(),
            deliver_result=fail_delivery,
            deliver_activity=activity,
        )

    assert records[-1]["status"] == "error"
    assert records[-1]["error"] == "delivery failed"
