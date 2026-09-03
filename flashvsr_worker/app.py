"""Private HTTP API for the isolated official FlashVSR worker.

This module intentionally has no import-time CUDA, model, or pipeline work.  A
failed compatibility check therefore leaves the endpoint reachable and lets the
H3 Studio BFF present a precise disabled reason instead of exposing a partly
initialised enhancement service.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable, Literal, Protocol
from uuid import uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from flashvsr_worker.contracts import SourceRef, TargetDimensions, WorkerJob
from flashvsr_worker.gate import load_gate_status
from flashvsr_worker.jobs import JobStore, TERMINAL_STATES
from flashvsr_worker.media import ValidationError, resolve_source, target_dimensions
from flashvsr_worker.runner import FlashVsrRunner, RunResult, SourceFacts


MODEL_NAME = "flashvsr-v1.1"


@dataclass(frozen=True)
class GateStatus:
    available: bool
    reason: str | None = None
    model: Literal["flashvsr-v1.1"] = MODEL_NAME
    supported_targets: tuple[Literal["2k", "4k"], ...] = ()


class SourceModel(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    subfolder: str | None = Field(default=None, max_length=180)
    type: Literal["output"] = "output"


class JobRequest(BaseModel):
    source: SourceModel
    target: Literal["2k", "4k"]


class Runner(Protocol):
    def probe_source(self, source: Path) -> SourceFacts: ...

    async def run(
        self,
        *,
        job_id: str,
        source: Path,
        facts: SourceFacts,
        dimensions: TargetDimensions,
        target: Literal["2k", "4k"],
        job_store: JobStore,
    ) -> RunResult: ...


def iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def public_snapshot(job: WorkerJob) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": job.id,
        "state": job.state,
        "target": job.target,
        "width": job.width,
        "height": job.height,
        "totalElapsedMs": job.total_elapsed_ms,
    }
    if job.message:
        payload["message"] = job.message
    if job.state == "completed" and job.output_filename and job.output_subfolder:
        payload["media"] = {
            "filename": job.output_filename,
            "subfolder": job.output_subfolder,
            "type": "output",
        }
    return payload


def gate_status_from_disk() -> GateStatus:
    payload = load_gate_status(Path(os.environ.get("FLASHVSR_STATE_DIR", "/state")))
    supported = tuple(
        target for target in payload.get("supportedTargets", [])
        if target in {"2k", "4k"}
    )
    return GateStatus(
        available=bool(payload.get("available")),
        reason=payload.get("reason") if isinstance(payload.get("reason"), str) else None,
        supported_targets=supported,  # type: ignore[arg-type]
    )


def create_app(
    *,
    output_root: Path | None = None,
    job_store: JobStore | None = None,
    runner: Runner | None = None,
    gate_status: Callable[[], GateStatus] = gate_status_from_disk,
) -> FastAPI:
    """Create a loopback-only worker app with injectable non-GPU test seams."""
    configured_output = (output_root or Path(os.environ.get("FLASHVSR_OUTPUT_ROOT", "/comfy-output"))).resolve()
    configured_state = Path(os.environ.get("FLASHVSR_STATE_DIR", "/state"))
    configured_work = Path(os.environ.get("FLASHVSR_WORK_DIR", "/work"))
    store = job_store or JobStore(configured_state, configured_work)
    selected_runner = runner or FlashVsrRunner(
        output_root=configured_output,
        model_dir=Path(os.environ.get("FLASHVSR_MODEL_DIR", "/models/FlashVSR")),
    )
    app = FastAPI(title="H3 Studio FlashVSR Worker", docs_url=None, redoc_url=None, openapi_url=None)

    async def run_job(
        job_id: str,
        source: Path,
        facts: SourceFacts,
        dimensions: TargetDimensions,
        target: Literal["2k", "4k"],
    ) -> None:
        started_ms = asyncio.get_running_loop().time() * 1000
        job = store.jobs.get(job_id)
        if job is None:
            return
        try:
            if job.state == "cancelling":
                job.message = "超分任务已停止。"
                job.updated_at = iso_now()
                await store.finish(job_id, "cancelled")
                return
            job.state = "preparing"
            job.message = "正在准备官方 FlashVSR 流水线。"
            job.updated_at = iso_now()
            result = await selected_runner.run(
                job_id=job_id,
                source=source,
                facts=facts,
                dimensions=dimensions,
                target=target,
                job_store=store,
            )
            job = store.jobs.get(job_id)
            if job is None:
                return
            if job.state == "cancelling":
                job.message = "超分任务已停止。"
                await store.finish(job_id, "cancelled")
                return
            job.state = "saving"
            job.message = "正在校验并保存增强视频。"
            job.output_filename = result.filename
            job.output_subfolder = result.subfolder
            job.updated_at = iso_now()
            await store.finish(job_id, "completed")
            job.message = "增强视频已完成。"
        except asyncio.CancelledError:
            job = store.jobs.get(job_id)
            if job is not None and job_id == store.active_job_id:
                job.message = "超分任务已停止。"
                await store.finish(job_id, "cancelled")
            raise
        except Exception as error:  # Child output is never surfaced as a media result.
            job = store.jobs.get(job_id)
            if job is not None and job_id == store.active_job_id:
                if job.state == "cancelling":
                    job.message = "超分任务已停止。"
                    await store.finish(job_id, "cancelled")
                else:
                    job.message = f"FlashVSR 未完成：{str(error)[:180]}"
                    await store.finish(job_id, "failed")
        finally:
            job = store.jobs.get(job_id)
            if job is not None:
                job.total_elapsed_ms = max(0, int(asyncio.get_running_loop().time() * 1000 - started_ms))
                job.updated_at = iso_now()

    @app.get("/health")
    async def health() -> dict[str, object]:
        status = gate_status()
        return {
            "available": status.available,
            "model": status.model,
            "supportedTargets": list(status.supported_targets) if status.available else [],
            **({"reason": status.reason} if status.reason else {}),
        }

    @app.post("/jobs", status_code=202)
    async def create_job(request: JobRequest):
        status = gate_status()
        if not status.available:
            return JSONResponse(
                {"message": status.reason or "FlashVSR 兼容性门槛尚未通过。"},
                status_code=503,
            )
        try:
            source_ref = SourceRef(
                filename=request.source.filename,
                subfolder=request.source.subfolder,
                type=request.source.type,
            )
            source = resolve_source(configured_output, source_ref)
            facts = selected_runner.probe_source(source)
            dimensions = target_dimensions(facts.width, facts.height, request.target)
        except ValidationError as error:
            return JSONResponse({"message": str(error)}, status_code=400)
        except Exception:
            return JSONResponse({"message": "无法读取原始视频信息。"}, status_code=400)

        if request.target not in status.supported_targets:
            return JSONResponse({"message": "当前 FlashVSR 兼容性门槛不支持该清晰度。"}, status_code=503)

        job_id = f"up-{uuid4()}"
        record = WorkerJob(
            id=job_id,
            source=source_ref,
            target=request.target,
            state="queued",
            width=dimensions.final_width,
            height=dimensions.final_height,
            message="已加入本地超分队列。",
            created_at=iso_now(),
            updated_at=iso_now(),
        )
        try:
            await store.reserve(job_id, record)
        except RuntimeError:
            return JSONResponse({"message": "已有 FlashVSR 任务正在执行，请等待其完成。"}, status_code=409)
        asyncio.create_task(run_job(job_id, source, facts, dimensions, request.target))
        return public_snapshot(record)

    @app.get("/jobs/{job_id}")
    async def get_job(job_id: str):
        job = store.jobs.get(job_id)
        if job is None:
            return JSONResponse({"message": "未找到 FlashVSR 任务。"}, status_code=404)
        return public_snapshot(job)

    @app.post("/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str):
        job = store.request_cancel(job_id)
        if job is None:
            return JSONResponse({"message": "未找到可停止的 FlashVSR 任务。"}, status_code=404)
        if job.state in TERMINAL_STATES:
            return public_snapshot(job)
        job.message = "正在停止超分任务…"
        job.updated_at = iso_now()
        return public_snapshot(job)

    return app


def _default_app() -> FastAPI:
    """Keep importing the worker testable when Docker state mounts are absent."""
    if os.environ.get("FLASHVSR_STATE_DIR"):
        return create_app()
    temporary_root = Path(tempfile.gettempdir()) / "h3-studio-flashvsr-local"
    return create_app(
        output_root=temporary_root / "comfy-output",
        job_store=JobStore(temporary_root / "state", temporary_root / "work"),
    )


app = _default_app()
