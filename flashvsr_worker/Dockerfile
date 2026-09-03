FROM comfyui-gb10:v2

ARG FLASHVSR_COMMIT=cf910c61a60733e610e9c6e8b607f80c3a6c202b
ARG BLOCK_SPARSE_COMMIT=49d6c39e4dc0303442cda3bb758b3925d4399c49
ARG CUTLASS_COMMIT=a75b4ac483166189a45290783cb0a18af5ff0ea5

ENV DEBIAN_FRONTEND=noninteractive \
    FLASHVSR_REPO=/opt/FlashVSR \
    FLASHVSR_MODEL_DIR=/models/FlashVSR \
    FLASHVSR_STATE_DIR=/state \
    FLASHVSR_OUTPUT_ROOT=/comfy-output \
    FLASHVSR_WORK_DIR=/work \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/h3-studio \
    PATH=/flashvsr-venv/bin:${PATH}

# The parent image starts ComfyUI by default. The sidecar deliberately has no
# inherited entrypoint and receives only its private virtual environment at run time.
ENTRYPOINT []

# Deployment stages exact-commit source archives before this build. Keeping the
# acquisition outside Docker makes slow or interrupted GitHub transfers resumable
# and avoids a full git history in the image layer.
USER root

COPY flashvsr-sources/FlashVSR.tar.gz /tmp/FlashVSR.tar.gz
COPY flashvsr-sources/Block-Sparse-Attention.tar.gz /tmp/Block-Sparse-Attention.tar.gz
COPY flashvsr-sources/CUTLASS.tar.gz /tmp/CUTLASS.tar.gz

RUN tar -tzf /tmp/FlashVSR.tar.gz | grep -q "^FlashVSR-${FLASHVSR_COMMIT}/" \
    && tar -tzf /tmp/Block-Sparse-Attention.tar.gz | grep -q "^Block-Sparse-Attention-${BLOCK_SPARSE_COMMIT}/" \
    && tar -tzf /tmp/CUTLASS.tar.gz | grep -q "^cutlass-${CUTLASS_COMMIT}/" \
    && mkdir -p /opt/FlashVSR /opt/Block-Sparse-Attention /opt/Block-Sparse-Attention/csrc/cutlass \
    && tar -xzf /tmp/FlashVSR.tar.gz --strip-components=1 -C /opt/FlashVSR \
    && tar -xzf /tmp/Block-Sparse-Attention.tar.gz --strip-components=1 -C /opt/Block-Sparse-Attention \
    && tar -xzf /tmp/CUTLASS.tar.gz --strip-components=1 -C /opt/Block-Sparse-Attention/csrc/cutlass

WORKDIR /opt/h3-studio
COPY flashvsr_worker /opt/h3-studio/flashvsr_worker

CMD ["/flashvsr-venv/bin/python", "-m", "uvicorn", "flashvsr_worker.app:app", "--host", "127.0.0.1", "--port", "8190"]
