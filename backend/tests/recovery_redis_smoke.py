"""Disposable Redis transport test; never connect to the production Redis port.

Runs real Celery consumption, late ACK and crash redelivery with a harmless task.
The fixture task stands in for AI/provider/database work; it never imports those
services. Run with a fresh Redis instance at 127.0.0.1:6387, database 15.
"""
import json
import os
import pathlib
import subprocess
import sys
import time
from urllib.parse import urlsplit

from redis import Redis
from app.core.recovery import ANALYSIS_TASK, ANALYSIS_QUEUE, TRANSPORT_PREFIX, RecoveryBlocked
from app.infrastructure.messaging.recovery_celery import RecoveryCelery, RecoveryTask, configure_recovery_queue

os.environ.setdefault("CREDX_RECOVERY_MODE", "1")
URL = os.getenv("RECOVERY_TEST_REDIS_URL", "redis://127.0.0.1:6387/15")
parsed = urlsplit(URL)
if parsed.scheme != "redis" or parsed.hostname != "127.0.0.1" or parsed.port != 6387 or parsed.path != "/15":
    raise RuntimeError("Disposable test Redis must be exactly 127.0.0.1:6387/15")

app = RecoveryCelery("recovery-smoke", broker=URL, backend=URL, task_cls=RecoveryTask)
configure_recovery_queue(app)
# Fixture worker intentionally does not load production AI/provider/DB modules.
app.conf.update(imports=(), task_acks_late=True, task_reject_on_worker_lost=True,
                worker_prefetch_multiplier=1,
                broker_transport_options={"global_keyprefix": TRANSPORT_PREFIX,
                                          "visibility_timeout": 1})


@app.task(name=ANALYSIS_TASK, queue="ai")
def harmless_analysis_fixture(job_id):
    client = Redis.from_url(URL)
    attempt = client.incr(TRANSPORT_PREFIX + "fixture-attempt")
    client.set(TRANSPORT_PREFIX + "fixture-started", attempt)
    if attempt == 1:
        time.sleep(90)  # Parent kills only this disposable worker before ACK.
    return {"fixture_job_id": job_id, "attempt": attempt}


def wait_for(predicate, seconds=45):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate(): return
        time.sleep(0.2)
    raise AssertionError("Disposable worker check timed out")


def main():
    client = Redis.from_url(URL)
    assert client.ping()
    assert client.dbsize() == 0, "Test requires a fresh disposable database"
    legacy_tags = {f"legacy-{i}": "fixture-financial-reservation" for i in range(15)}
    client.hset("unacked", mapping=legacy_tags)
    client.zadd("unacked_index", {tag: 0 for tag in legacy_tags})
    client.rpush("beat", "fixture-financial-queued-message")
    legacy = (client.hgetall("unacked"), client.zrange("unacked_index", 0, -1, withscores=True),
              client.lrange("beat", 0, -1))
    processes = []
    handles = []
    def start_worker():
        handle = open(f"recovery-worker-{len(processes) + 1}.log", "w")
        handles.append(handle)
        process = subprocess.Popen([
            sys.executable, "-m", "celery", "-A", "recovery_redis_smoke:app", "worker",
            "--pool=solo", "--concurrency=1", "--loglevel=WARNING",
            "--without-gossip", "--without-mingle", "--without-heartbeat",
            "-Q", ANALYSIS_QUEUE,
        ], stdout=handle, stderr=subprocess.STDOUT)
        processes.append(process)
        return process
    try:
        try: app.send_task("financial", args=["fixture"])
        except RecoveryBlocked: pass
        else: raise AssertionError("Financial task published")
        task = harmless_analysis_fixture.apply_async(args=[123], queue="ai", routing_key="beat")
        assert client.llen(TRANSPORT_PREFIX + ANALYSIS_QUEUE) == 1
        first = start_worker()
        wait_for(lambda: client.get(TRANSPORT_PREFIX + "fixture-started") == b"1")
        assert client.hlen(TRANSPORT_PREFIX + "unacked") == 1
        assert legacy == (client.hgetall("unacked"), client.zrange("unacked_index", 0, -1, withscores=True), client.lrange("beat", 0, -1))
        first.kill()
        first.wait(timeout=10)
        time.sleep(2)
        start_worker()
        wait_for(lambda: task.ready(), seconds=60)
        result = task.get(timeout=5)
        assert result == {"fixture_job_id": 123, "attempt": 2}
        wait_for(lambda: client.hlen(TRANSPORT_PREFIX + "unacked") == 0)
        assert client.zcard(TRANSPORT_PREFIX + "unacked_index") == 0
        assert legacy == (client.hgetall("unacked"), client.zrange("unacked_index", 0, -1, withscores=True), client.lrange("beat", 0, -1))
        evidence = {"realRedisConsumeAckCrashRedelivery": "passed", "legacyReservedPreserved": 15,
                    "legacyBeatPreserved": 1, "fixtureAttempts": 2, "financialPublicationRejected": True,
                    "brokerResultPrefix": TRANSPORT_PREFIX, "realAIProvidersOrProductionAccess": False}
        pathlib.Path("recovery-redis-smoke.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence))
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        for handle in handles: handle.close()


if __name__ == "__main__": main()
