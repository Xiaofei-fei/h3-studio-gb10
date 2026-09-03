import asyncio
import os
import re
import shutil
import signal
from pathlib import Path
from typing import Sequence

from realesrgan_worker.contracts import WorkerJob


TERMINAL_STATES = {"completed", "failed", "cancelled"}
SAFE_JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


class JobStore:
    """Track exactly one worker-owned GPU child process and its work directory."""

    def __init__(self, state_root: Path, work_root: Path) -> None:
        self.state_root = state_root.resolve()
        self.work_root = work_root.resolve()
        self.state_root.mkdir(parents=True, exist_ok=True)
        self.work_root.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, WorkerJob] = {}
        self._active_job_id: str | None = None
        self._processes: dict[str, tuple[int, asyncio.subprocess.Process | None]] = {}
        self._lock = asyncio.Lock()

    @property
    def active_job_id(self) -> str | None:
        return self._active_job_id

    def create(self, job_id: str, job: WorkerJob | None = None) -> WorkerJob:
        if not SAFE_JOB_ID.fullmatch(job_id):
            raise ValueError("不安全的稳定增强任务 ID。")
        if self._active_job_id is not None:
            raise RuntimeError("已有稳定增强任务正在执行。")
        record = job or WorkerJob(id=job_id)
        if record.id != job_id:
            raise ValueError("任务 ID 不一致。")
        self.jobs[job_id] = record
        self._active_job_id = job_id
        self.work_dir(job_id).mkdir(parents=True, exist_ok=True)
        return record

    async def reserve(self, job_id: str, job: WorkerJob | None = None) -> WorkerJob:
        async with self._lock:
            return self.create(job_id, job)

    def work_dir(self, job_id: str) -> Path:
        if not SAFE_JOB_ID.fullmatch(job_id):
            raise ValueError("不安全的稳定增强任务 ID。")
        path = (self.work_root / job_id).resolve()
        if path.parent != self.work_root:
            raise ValueError("稳定增强工作目录不安全。")
        return path

    def attach_process(
        self,
        job_id: str,
        pid: int,
        process: asyncio.subprocess.Process | None = None,
    ) -> None:
        if job_id != self._active_job_id or job_id not in self.jobs:
            raise RuntimeError("只能附加当前稳定增强任务的子进程。")
        if pid <= 0:
            raise ValueError("子进程 PID 不正确。")
        self._processes[job_id] = (pid, process)

    async def spawn(self, job_id: str, command: Sequence[str]) -> asyncio.subprocess.Process:
        if job_id != self._active_job_id:
            raise RuntimeError("只能启动当前稳定增强任务。")
        job = self.jobs.get(job_id)
        if job is None:
            raise RuntimeError("未找到当前稳定增强任务。")
        if job.state == "cancelling":
            raise asyncio.CancelledError()
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=self.work_dir(job_id),
            start_new_session=True,
        )
        self.attach_process(job_id, process.pid, process)
        return process

    def request_cancel(self, job_id: str) -> WorkerJob | None:
        if job_id != self._active_job_id:
            return None
        job = self.jobs.get(job_id)
        if not job or job.state in TERMINAL_STATES:
            return job
        job.state = "cancelling"
        tracked = self._processes.get(job_id)
        if tracked is None:
            return job
        pid, process = tracked
        os.killpg(pid, signal.SIGTERM)
        if process is not None:
            try:
                asyncio.get_running_loop().create_task(self._force_kill_if_needed(job_id, pid, process))
            except RuntimeError:
                pass
        return job

    async def _force_kill_if_needed(
        self,
        job_id: str,
        pid: int,
        process: asyncio.subprocess.Process,
    ) -> None:
        try:
            await asyncio.wait_for(process.wait(), timeout=10)
        except asyncio.TimeoutError:
            tracked = self._processes.get(job_id)
            if (
                job_id == self._active_job_id
                and tracked is not None
                and tracked[0] == pid
                and process.returncode is None
            ):
                os.killpg(pid, signal.SIGKILL)

    async def finish(self, job_id: str, state: str) -> WorkerJob | None:
        async with self._lock:
            job = self.jobs.get(job_id)
            if job is None or job_id != self._active_job_id:
                return job
            if state not in TERMINAL_STATES:
                raise ValueError("稳定增强任务必须以终态完成。")
            self._remove_owned_work_dir(job_id)
            self._processes.pop(job_id, None)
            self._active_job_id = None
            job.state = state  # type: ignore[assignment]
            return job

    def _remove_owned_work_dir(self, job_id: str) -> None:
        if job_id != self._active_job_id:
            return
        path = self.work_dir(job_id)
        if path.exists():
            shutil.rmtree(path)
