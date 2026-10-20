"""Private stream names bind both the owner and resource server-side."""


def job_channel(user_id: int, job_id: int) -> str:
    return f'user_job_updates:{int(user_id)}:job:{int(job_id)}'


def run_channel(user_id: int, run_id: int) -> str:
    return f'user_run_updates:{int(user_id)}:run:{int(run_id)}'
