ARG COMFYUI_RUNTIME_IMAGE=comfyui-gb10:v2
FROM ${COMFYUI_RUNTIME_IMAGE}

# The parent image normally starts ComfyUI. This small sidecar has no inherited
# entrypoint and imports GPU packages only in a tracked child job process.
ENTRYPOINT []

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/opt/h3-studio \
    REALESRGAN_MODEL_DIR=/models/RealESRGAN \
    REALESRGAN_STATE_DIR=/state \
    REALESRGAN_OUTPUT_ROOT=/comfy-output \
    REALESRGAN_WORK_DIR=/work

USER root
WORKDIR /opt/h3-studio
COPY realesrgan_worker /opt/h3-studio/realesrgan_worker

# /worker-venv is a read-only mount of the existing private GB10 Python 3.12
# runtime. This image deliberately performs no package installation or model download.
CMD ["/worker-venv/bin/python", "-m", "uvicorn", "realesrgan_worker.app:app", "--host", "0.0.0.0", "--port", "8191"]
