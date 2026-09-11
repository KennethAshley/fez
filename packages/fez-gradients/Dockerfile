# ghcr.io/fezchat/gradients-miner — G.O.D at the pinned commit with its
# venv baked. The deadsnakes/pip dance from the 2026-09-08 live run,
# solved once here instead of on every user's box.
FROM python:3.10-slim
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential \
  && rm -rf /var/lib/apt/lists/*
ARG GOD_COMMIT=c4cf8f41a9c773bb6356ce8175bae8f632e74669
RUN git clone https://github.com/gradients-ai/G.O.D.git /app \
  && cd /app && git checkout "$GOD_COMMIT"
WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir -e .
COPY container/fez_submission.py container/entrypoint.py container/smoke.py /app/
COPY container/training_repo.py /app/miner/endpoints/training_repo.py
RUN python /app/smoke.py && fiber-post-ip --help
EXPOSE 7999
ENV ENV=DEV NETUID=241 SUBTENSOR_NETWORK=test
ENTRYPOINT ["python", "/app/entrypoint.py"]
CMD ["uvicorn", "miner.asgi:app", "--host", "0.0.0.0", "--port", "7999", "--log-level", "info"]
