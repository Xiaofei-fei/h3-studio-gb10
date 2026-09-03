"""Private HTTP API for the isolated deterministic RealESRGAN worker."""

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

from realesrgan_worker.contracts import (
    MODEL_NAME,
    SUPPORTED_PROFILES,
    SourceRef,
    TargetDimensions,
    WorkerJob,
    target_dimensions,
)
from realesrgan_worker.jobs import JobStore, TERMINAL_STATES
from realesrgan_worker.media import ValidationError, resolve_source
from realesrgan_worker.runner import DeterministicRunner, RunResult, SourceFacts, readiness_reason


@dataclass(frozen=True)
class WorkerStatus:
    available: bool
    reason: str | None = None
    model: Literal["realesrgan-x2plus-fp16"] = MODEL_NAME


class SourceModel(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    subfolder: str | None = Field(default=None, max_length=180)
    type: Literal["output"] = "output"


class JobRequest(BaseModel):
    source: SourceModel
    target: Literal["2k"]


class Runner(Protocol):
    def probe_source(self, source: Path) -> SourceFacts: ...

    async def run(
        self,
        *,
        job_id: str,
        source: Path,
        facts: SourceFacts,
        dimensions: TargetDimensions,
        target: str,
        job_store: JobStore,
    ) -> RunResult: ...


def iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def worker_status_from_environment() -> WorkerStatus:
    model_dir = Path(os.environ.get("REALESRGAN_MODEL_DIR", "/models/RealESRGAN"))
    reason = readiness_reason(model_dir)
    return WorkerStatus(available=reason is None, reason=reason)


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


def public_profiles() -> list[dict[str, object]]:
    return [{
        "sourceWidth": profile.source_width,
        "sourceHeight": profile.source_height,
        "target": profile.target,
        "width": profile.dimensions.final_width,
        "height": profile.dimensions.final_height,
    } for profile in SUPPORTED_PROFILES]


def create_app(
    *,
    output_root: Path | None = None,
    job_store: JobStore | None = None,
    runner: Runner | None = None,
    worker_status: Callable[[], WorkerStatus] = worker_status_from_environment,
) -> FastAPI:
    """Create a loopback-only worker app with injectable, non-GPU test seams."""
    configured_output = (output_root or Path(os.environ.get("REALESRGAN_OUTPUT_ROOT", "/comfy-output"))).resolve()
    configured_state = Path(os.environ.get("REALESRGAN_STATE_DIR", "/state"))
    configured_work = Path(os.environ.get("REALESRGAN_WORK_DIR", "/work"))
    store = job_store or JobStore(configured_state, configured_work)
    selected_runner = runner or DeterministicRunner(
        output_root=configured_output,
        model_dir=Path(os.environ.get("REALESRGAN_MODEL_DIR", "/models/RealESRGAN")),
    )
    app = FastAPI(title="H3 Studio Deterministic RealESRGAN Worker", docs_url=None, redoc_url=None, openapi_url=None)

    def cleanup_cancelled_output(job_id: str, source: Path) -> None:
        cleaner = getattr(selected_runner, "cleanup_cancelled_output", None)
        if not callable(cleaner):
            return
        try:
            cleaner(source, job_id)
        except Exception:
            # Cancellation must not become a failed request if an already-gone
            # worker-owned temporary file cannot be inspected again.
            pass

    async def run_job(
        job_id: str,
        source: Path,
        facts: SourceFacts,
        dimensions: TargetDimensions,
        target: str,
    ) -> None:
        started_ms = asyncio.get_running_loop().time() * 1000
        job = store.jobs.get(job_id)
        if job is None:
            return
        try:
            if job.state == "cancelling":
                cleanup_cancelled_output(job_id, source)
                job.message = "稳定增强任务已停止。"
                job.updated_at = iso_now()
                await store.finish(job_id, "cancelled")
                return
            job.state = "preparing"
            job.message = "正在准备确定性 RealESRGAN 增强。"
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
                cleanup_cancelled_output(job_id, source)
                job.message = "稳定增强任务已停止。"
                await store.finish(job_id, "cancelled")
                return
            job.state = "saving"
            job.message = "正在校验并保存 2K 稳定增强视频。"
            job.output_filename = result.filename
            job.output_subfolder = result.subfolder
            job.updated_at = iso_now()
            await store.finish(job_id, "completed")
            job.message = "2K 稳定增强已完成。"
        except asyncio.CancelledError:
            job = store.jobs.get(job_id)
            if job is not None and job_id == store.active_job_id:
                cleanup_cancelled_output(job_id, source)
                job.message = "稳定增强任务已停止。"
                await store.finish(job_id, "cancelled")
            raise
        except Exception as error:
            job = store.jobs.get(job_id)
            if job is not None and job_id == store.active_job_id:
                if job.state == "cancelling":
                    cleanup_cancelled_output(job_id, source)
                    job.message = "稳定增强任务已停止。"
                    await store.finish(job_id, "cancelled")
                else:
                    job.message = f"稳定增强未完成：{str(error)[:180]}"
                    await store.finish(job_id, "failed")
        finally:
            job = store.jobs.get(job_id)
            if job is not None:
                job.total_elapsed_ms = max(0, int(asyncio.get_running_loop().time() * 1000 - started_ms))
                job.updated_at = iso_now()

    @app.get("/health")
    async def health() -> dict[str, object]:
        status = worker_status()
        return {
            "available": status.available,
            "model": status.model,
            "supportedProfiles": public_profiles() if status.available else [],
            **({"reason": status.reason} if status.reason else {}),
        }

    @app.post("/jobs", status_code=202)
    async def create_job(request: JobRequest):
        status = worker_status()
        if not status.available:
            return JSONResponse(
                {"message": status.reason or "稳定增强服务尚未就绪。"},
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

        job_id = f"det-{uuid4()}"
        record = WorkerJob(
            id=job_id,
            source=source_ref,
            target=request.target,
            state="queued",
            width=dimensions.final_width,
            height=dimensions.final_height,
            message="已加入本地稳定增强队列。",
            created_at=iso_now(),
            updated_at=iso_now(),
        )
        try:
            await store.reserve(job_id, record)
        except RuntimeError:
            return JSONResponse({"message": "已有稳定增强任务正在执行，请等待其完成。"}, status_code=409)
        asyncio.create_task(run_job(job_id, source, facts, dimensions, request.target))
        return public_snapshot(record)

    @app.get("/jobs/{job_id}")
    async def get_job(job_id: str):
        job = store.jobs.get(job_id)
        if job is None:
            return JSONResponse({"message": "未找到稳定增强任务。"}, status_code=404)
        return public_snapshot(job)

    @app.post("/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str):
        job = store.request_cancel(job_id)
        if job is None:
            return JSONResponse({"message": "未找到可停止的稳定增强任务。"}, status_code=404)
        if job.state in TERMINAL_STATES:
            return public_snapshot(job)
        job.message = "正在停止稳定增强任务…"
        job.updated_at = iso_now()
        return public_snapshot(job)

    return app


def _default_app() -> FastAPI:
    """Keep imports testable when Docker state mounts are absent."""
    if os.environ.get("REALESRGAN_STATE_DIR"):
        return create_app()
    temporary_root = Path(tempfile.gettempdir()) / "h3-studio-realesrgan-local"
    return create_app(
        output_root=temporary_root / "comfy-output",
        job_store=JobStore(temporary_root / "state", temporary_root / "work"),
    )


app = _default_app()
