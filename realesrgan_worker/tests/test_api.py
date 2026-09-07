from pathlib import Path

from fastapi.testclient import TestClient

from realesrgan_worker.app import SourceFacts, WorkerStatus, create_app
from realesrgan_worker.jobs import JobStore


class FakeRunner:
    def probe_source(self, _source: Path) -> SourceFacts:
        return SourceFacts(width=832, height=480, fps="24/1", frames=73, has_audio=True)


def test_worker_health_reports_the_verified_profiles(
    output_root: Path,
    job_store: JobStore,
) -> None:
    client = TestClient(create_app(
        output_root=output_root,
        job_store=job_store,
        runner=FakeRunner(),
        worker_status=lambda: WorkerStatus(available=True),
    ))

    response = client.get("/health")

    assert response.json() == {
        "available": True,
        "model": "realesrgan-x2plus-fp16",
        "supportedProfiles": [{
            "sourceWidth": 832,
            "sourceHeight": 480,
            "target": "2k",
            "width": 2560,
            "height": 1478,
        }, {
            "sourceWidth": 1280,
            "sourceHeight": 720,
            "target": "2k",
            "width": 2560,
            "height": 1440,
        }, {
            "sourceWidth": 1344,
            "sourceHeight": 768,
            "target": "2k",
            "width": 2560,
            "height": 1464,
        }, {
            "sourceWidth": 1024,
            "sourceHeight": 576,
            "target": "2k",
            "width": 2560,
            "height": 1440,
        }, {
            "sourceWidth": 576,
            "sourceHeight": 1024,
            "target": "2k",
            "width": 1440,
            "height": 2560,
        }, {
            "sourceWidth": 768,
            "sourceHeight": 768,
            "target": "2k",
            "width": 2048,
            "height": 2048,
        }],
    }


def test_worker_rejects_an_unverified_target_before_queueing(
    output_root: Path,
    job_store: JobStore,
) -> None:
    client = TestClient(create_app(
        output_root=output_root,
        job_store=job_store,
        runner=FakeRunner(),
        worker_status=lambda: WorkerStatus(available=True),
    ))

    response = client.post("/jobs", json={
        "source": {"filename": "coffee.mp4", "subfolder": "H3Studio", "type": "output"},
        "target": "4k",
    })

    assert response.status_code == 422


def test_worker_reports_why_it_is_disabled(
    output_root: Path,
    job_store: JobStore,
) -> None:
    client = TestClient(create_app(
        output_root=output_root,
        job_store=job_store,
        runner=FakeRunner(),
        worker_status=lambda: WorkerStatus(available=False, reason="RealESRGAN 模型校验失败。"),
    ))

    response = client.get("/health")

    assert response.json() == {
        "available": False,
        "model": "realesrgan-x2plus-fp16",
        "supportedProfiles": [],
        "reason": "RealESRGAN 模型校验失败。",
    }
