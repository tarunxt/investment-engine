import asyncio
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app.domains.jobs.resource_body import ResourceBodyMiddleware
from app.domains.jobs.resource_policy import MAX_BODY_BYTES, MAX_PROMPT_CHARS
from app.domains.jobs.schemas import JobCreate
from app.domains.runs.schemas import RunCreate
def target():
    return {'provider': 'synthetic', 'model': 'selected-model'}

@pytest.mark.parametrize('count,accepted', [(1, True), (8, True), (9, False)])
def test_targets_count_repeated_samples_without_rewriting(count, accepted):
    payload = {'prompt': 'all financial context retained', 'targets': [target()] * count}
    if accepted:
        obj = RunCreate(**payload)
        assert len(obj.targets) == count and obj.prompt == payload['prompt']
    else:
        with pytest.raises(ValidationError):
            RunCreate(**payload)

@pytest.mark.parametrize('text,accepted', [('x' * MAX_PROMPT_CHARS, True), ('x' * (MAX_PROMPT_CHARS + 1), False), ('😀' * 524288, True), ('😀' * 524289, False)])
def test_prompt_has_both_character_and_utf8_byte_limits(text, accepted):
    for constructor, fields in [(JobCreate, target()), (RunCreate, {'targets': [target()]})]:
        if accepted:
            assert constructor(prompt=text, **fields).prompt == text
        else:
            with pytest.raises(ValidationError):
                constructor(prompt=text, **fields)

@pytest.mark.parametrize('root,path', [('', '/jobs'), ('', '/runs/'), ('/api', '/api/jobs')])
def test_chunked_body_rejects_before_handler_even_with_false_length(root, path):

    async def exercise():
        calls, messages = ([], [])

        async def downstream(*args):
            calls.append('handler')
        chunks = iter([{'type': 'http.request', 'body': b'x' * (MAX_BODY_BYTES // 2), 'more_body': True}, {'type': 'http.request', 'body': b'x' * (MAX_BODY_BYTES // 2 + 1)}])

        async def receive():
            return next(chunks)

        async def send(message):
            messages.append(message)
        await ResourceBodyMiddleware(downstream)({'type': 'http', 'method': 'POST', 'path': path, 'root_path': root, 'headers': [(b'content-length', b'1')]}, receive, send)
        assert not calls and messages[0]['status'] == 413
        assert len(messages[1]['body']) < 200
    asyncio.run(exercise())

def test_ordinary_untagged_request_remains_available_without_adapter_certification():
    app = FastAPI()
    app.add_middleware(ResourceBodyMiddleware)
    called = []

    @app.post('/jobs')
    async def submit(body: JobCreate):
        called.append(body)
        return {'accepted': True}
    with TestClient(app) as client:
        response = client.post('/jobs', json={'prompt': 'unchanged strategy', **target()})
    assert response.status_code == 200 and response.json() == {'accepted': True}
    assert called[0].model == 'selected-model'
