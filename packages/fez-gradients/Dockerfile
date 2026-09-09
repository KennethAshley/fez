# ghcr.io/fezchat/gradients-miner — G.O.D at the pinned commit with its
# venv baked. The deadsnakes/pip dance from the 2026-09-08 live run,
# solved once here instead of on every user's box.
FROM python:3.10-slim
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential \
  && rm -rf /var/lib/apt/lists/*
ARG GOD_COMMIT=ebbd3d729c8c36173eac7022ff9aa29907d7f643
RUN git clone https://github.com/rayonlabs/G.O.D.git /app \
  && cd /app && git checkout "$GOD_COMMIT"
WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip \
  && pip uninstall -y substrate-interface scalecodec cyscale || true \
  && pip install --no-cache-dir -e .
EXPOSE 7999
ENV ENV=DEV
CMD ["uvicorn", "miner.asgi:app", "--host", "0.0.0.0", "--port", "7999", "--log-level", "info"]
