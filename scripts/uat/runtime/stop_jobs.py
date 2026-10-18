"""Read-only bounded settling barrier; never starts or stops a service itself."""
import time


def wait_stop_jobs_settled(run, *, clock=time.monotonic, sleep=time.sleep):
    until = clock() + 20
    while clock() < until:
        result = run(['systemctl', 'show', '--no-pager', '-p', 'ActiveState',
                      '--value', 'credx-uat-live-fail-stop.service'],
                     timeout=2, check=False)
        if result.returncode != 0:
            raise ValueError('stop service state unavailable')
        state = result.stdout.strip()
        jobs = run(['systemctl', 'list-jobs', '--no-legend', '--no-pager'],
                   timeout=2).stdout.splitlines()
        pending = [line for line in jobs if len(line.split()) >= 3
                   and line.split()[1].startswith('credx-uat-')
                   and line.split()[2] in ('stop', 'restart', 'try-restart')]
        if clock() >= until:
            break
        if state in ('inactive', 'failed') and not pending:
            return
        sleep(.2)
    raise ValueError('previous stop jobs not settled')
