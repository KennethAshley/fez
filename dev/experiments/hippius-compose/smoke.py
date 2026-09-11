"""Bounded loopback test of the official binary, not a replacement validator.

Protocol: thenervelab/arion@6a07b7f, common/src/lib.rs and miner/src/p2p.rs.
No RPC, registration ACK, production peer, or real wallet is involved.
"""
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import ssl
import stat
import struct
import subprocess
import sys

from aioquic.asyncio import connect
from aioquic.quic.configuration import QuicConfiguration
from blake3 import blake3
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.x509.oid import NameOID

DATA = Path("/data")
PAYLOAD_SIZE = 64 * 1024


async def request(connection, message, data=None):
    header = json.dumps(message, separators=(",", ":")).encode()
    wire = header if data is None else b"\x02" + struct.pack("<I", len(header)) + header + data
    reader, writer = await connection.create_stream()
    writer.write(wire)
    writer.write_eof()
    response = await asyncio.wait_for(reader.read(PAYLOAD_SIZE + 1024), 8)
    # read(n) can return a partial chunk; consume through EOF with a fixed bound.
    while len(response) <= PAYLOAD_SIZE + 1024:
        chunk = await asyncio.wait_for(reader.read(PAYLOAD_SIZE + 1025 - len(response)), 8)
        if not chunk:
            return response
        response += chunk
    raise AssertionError("Oversized miner response")


async def main(phase):
    # Refuse to run if Docker isolation was accidentally removed.
    assert {p.name for p in Path("/sys/class/net").iterdir()} == {"lo"}, "Requires network_mode: none"
    assert phase in {"seed", "verify"}, "Use seed or verify"
    os.umask(0o077)
    marker = DATA / "expected.json"
    if phase == "seed":
        assert not marker.exists(), "Existing trial: use verify, or a new Compose project name"
        payload = os.urandom(PAYLOAD_SIZE)
        (DATA / "expected-shard.bin").write_bytes(payload)
    else:
        assert marker.exists(), "Run seed first"
        payload = (DATA / "expected-shard.bin").read_bytes()
    digest = blake3(payload).hexdigest()

    # Disposable local validator signing identity. Never reads a user's wallet.
    key = Ed25519PrivateKey.generate()
    node_id = key.public_key().public_bytes_raw().hex()
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "hippius-offline-test")])
    now = datetime.now(timezone.utc)
    certificate = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
                   .public_key(key.public_key()).serial_number(x509.random_serial_number())
                   .not_valid_before(now - timedelta(minutes=1))
                   .not_valid_after(now + timedelta(hours=1)).sign(key, None))
    config = QuicConfiguration(is_client=True, alpn_protocols=["hippius/miner-control"],
                               idle_timeout=10, max_data=2**20, max_stream_data=2**20)
    config.certificate, config.private_key = certificate, key
    # Self-signed TLS is confined to loopback in a network-disabled container.
    config.verify_mode = ssl.CERT_NONE
    Path("miner.toml").write_text('''
[network]
hostname = "127.0.0.1"
bind_ipv4 = "127.0.0.1"
p2p_port = 11220
auto_detect_ip = false
family_id = "fez-offline-storage-test"
[storage]
path = "/data/miner/blobs"
data_dir = "/data/miner"
max_storage_gb = 1
[validator]
addr = "127.0.0.1:11221"
direct_addrs = "127.0.0.1:11221"
[tuning]
store_concurrency = 2
pull_concurrency = 2
fetch_concurrency = 2
''')
    env = {**os.environ, "AUTO_UPDATE_DISABLED": "true", "STUN_ENABLED": "false",
           "HOSTNAME": "127.0.0.1", "VALIDATOR_NODE_ID": node_id,
           "VALIDATOR_ADDR": "127.0.0.1:11221", "WARDEN_NODE_ID": node_id,
           "TOKIO_WORKER_THREADS": "2", "RUST_LOG": "info"}
    log_path = Path("/tmp/miner.log")
    with log_path.open("w") as log:
        process = subprocess.Popen(["arion-miner"], env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                assert process.poll() is None, log_path.read_text()[-3000:]
                if "Registering with validator via P2P" in log_path.read_text():
                    break
                await asyncio.sleep(0.1)
            else:
                raise AssertionError("Miner startup timed out: " + log_path.read_text()[-3000:])
            identity = DATA / "miner/keypair.bin"
            assert stat.S_IMODE(identity.stat().st_mode) == 0o600
            identity_hash = hashlib.sha256(identity.read_bytes()).hexdigest()
            async with connect("127.0.0.1", 11220, configuration=config) as connection:
                if phase == "seed":
                    assert await request(connection, {"CheckBlob": {"hash": digest}}) == b"HAS:false"
                    header = {"hash": digest, "data_len": len(payload), "validator_signature": [0] * 64}
                    assert await request(connection, {"StoreV2": header}, payload) == b"ERROR: UNAUTHORIZED"
                    header["validator_signature"] = list(key.sign(f"UPLOAD:{digest}".encode()))
                    corrupt = bytes([payload[0] ^ 1]) + payload[1:]
                    assert await request(connection, {"StoreV2": header}, corrupt) == b"ERROR: Hash mismatch"
                    assert await request(connection, {"CheckBlob": {"hash": digest}}) == b"HAS:false"
                    assert await request(connection, {"StoreV2": header}, payload) == b"OK"
                    print("PASS: invalid signature and corrupt shard rejected; signed 64 KiB shard accepted")
                else:
                    expected = json.loads(marker.read_text())
                    assert expected == {"hash": digest, "identity_hash": identity_hash}, "Persistent identity/data changed"
                assert await request(connection, {"CheckBlob": {"hash": digest}}) == b"HAS:true"
                assert await request(connection, {"FetchBlob": {"hash": digest}}) == b"DATA:" + payload
            if phase == "seed":
                marker.write_text(json.dumps({"hash": digest, "identity_hash": identity_hash}))
            print("PASS: shard retrieved byte-for-byte" + (" after container replacement; identity preserved" if phase == "verify" else ""))
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    print("OFFLINE ONLY: no on-chain registration, public validator, or rewards tested")


if __name__ == "__main__":
    asyncio.run(asyncio.wait_for(main(sys.argv[1] if len(sys.argv) > 1 else "seed"), 60))
