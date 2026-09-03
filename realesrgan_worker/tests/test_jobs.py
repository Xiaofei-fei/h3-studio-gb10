import os
import signal
import asyncio

import pytest

from realesrgan_worker.jobs import JobStore


def test_cancel_signals_only_the_active_worker_child_process_group(
    job_store: JobStore,
    monkeypatch,
) -> None:
    killed: list[tuple[int, signal.Signals]] = []
    monkeypatch.setattr(os, "killpg", lambda pid, sig: killed.append((pid, sig)))
    job_store.create("up-1")
    job_store.attach_process("up-1", 4321)

    job_store.request_cancel("up-1")

    assert killed == [(4321, signal.SIGTERM)]


def test_cancel_never_signals_a_non_active_worker_job(
    job_store: JobStore,
    monkeypatch,
) -> None:
    killed: list[tuple[int, signal.Signals]] = []
    monkeypatch.setattr(os, "killpg", lambda pid, sig: killed.append((pid, sig)))
    job_store.create("up-1")
    job_store.attach_process("up-1", 4321)

    job_store.request_cancel("someone-else")

    assert killed == []


def test_cancelled_job_never_spawns_a_late_gpu_child(
    job_store: JobStore,
    monkeypatch,
) -> None:
    job_store.create("up-1")
    job_store.request_cancel("up-1")

    async def unexpected_spawn(*_args, **_kwargs):
        raise AssertionError("cancelled job tried to spawn a child")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", unexpected_spawn)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(job_store.spawn("up-1", ["python", "-c", "pass"]))
