FROM python:3.10-slim@sha256:fd76ade0c607f27677bc04be3c60749f400eedc941d9e72967e19a4cedff80c2

# Official Linux release, verified before execution; no build from an unpinned branch.
RUN python -c 'import hashlib, pathlib, urllib.request; data = urllib.request.urlopen("https://github.com/thenervelab/arion/releases/download/v0.1.32/miner-linux-x86_64", timeout=120).read(); assert hashlib.sha256(data).hexdigest() == "c57438ab7de0222e83f95b4dac2abfa0a2d180cf5f27197a62a5dd6fc01f86fc"; pathlib.Path("/usr/local/bin/arion-miner").write_bytes(data)'
RUN chmod 755 /usr/local/bin/arion-miner \
    && pip install --no-cache-dir aioquic==1.3.0 blake3==1.0.9 \
    && mkdir /data && chown 65534:65534 /data
COPY smoke.py /probe/smoke.py
USER 65534:65534
WORKDIR /tmp
ENTRYPOINT ["python", "-u", "/probe/smoke.py"]
