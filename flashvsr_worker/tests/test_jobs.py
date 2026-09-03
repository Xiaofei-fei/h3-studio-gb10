import os
import signal


def test_cancel_signals_only_the_active_child_process_group(job_store, monkeypatch) -> None:
    killed: list[tuple[int, signal.Signals]] = []
    monkeypatch.setattr(os, "killpg", lambda pid, sig: killed.append((pid, sig)))
    job_store.create("up-1")
    job_store.attach_process("up-1", 4321)

    job_store.request_cancel("up-1")

    assert killed == [(4321, signal.SIGTERM)]


def test_cancel_never_signals_a_non_active_job(job_store, monkeypatch) -> None:
    killed: list[tuple[int, signal.Signals]] = []
    monkeypatch.setattr(os, "killpg", lambda pid, sig: killed.append((pid, sig)))
    job_store.create("up-1")
    job_store.attach_process("up-1", 4321)

    job_store.request_cancel("someone-else")

    assert killed == []
