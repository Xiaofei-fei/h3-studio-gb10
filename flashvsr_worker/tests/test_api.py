from pathlib import Path

from fastapi.testclient import TestClient

from flashvsr_worker.app import GateStatus, SourceFacts, create_app


class FakeRunner:
    def probe_source(self, _source: Path) -> SourceFacts:
        return SourceFacts(width=832, height=480, fps="24/1", frames=124, has_audio=True)


def test_worker_rejects_4k_for_480p(output_root: Path, job_store) -> None:
    client = TestClient(create_app(
        output_root=output_root,
        job_store=job_store,
        runner=FakeRunner(),
        gate_status=lambda: GateStatus(available=True, supported_targets=("2k", "4k")),
    ))

    response = client.post("/jobs", json={
        "source": {"filename": "coffee.mp4", "subfolder": "H3Studio", "type": "output"},
        "target": "4k",
    })

    assert response.status_code == 400
    assert "480P" in response.json()["message"]


def test_worker_health_reports_a_gate_failure(output_root: Path, job_store) -> None:
    client = TestClient(create_app(
        output_root=output_root,
        job_store=job_store,
        gate_status=lambda: GateStatus(
            available=False,
            reason="Block-Sparse Attention compatibility gate failed: import",
            supported_targets=(),
        ),
    ))

    response = client.get("/health")

    assert response.json() == {
        "available": False,
        "model": "flashvsr-v1.1",
        "supportedTargets": [],
        "reason": "Block-Sparse Attention compatibility gate failed: import",
    }
