"""Synthetic build files only; no Next process, external resources or credentials."""
import json
import pytest
from scripts.public_launch.concept_f_build_receipt import write_receipt,verified_build

def fixture(tmp_path):
    (tmp_path/'source.json').write_text(json.dumps({'sha':'a'*40}));build=tmp_path/'frontend/.next';(build/'server').mkdir(parents=True);(build/'static').mkdir();(tmp_path/'backend/app').mkdir(parents=True)
    (build/'BUILD_ID').write_text('synthetic-build');(build/'server/page.js').write_text('synthetic compiled page');(build/'static/style.css').write_text('synthetic stylesheet');(tmp_path/'backend/app/main.py').write_text('synthetic runtime source');return build,tmp_path/'backend/app'

def test_build_source_comes_from_archive_and_not_checkout_head(tmp_path):
    build,backend=fixture(tmp_path);value=write_receipt(tmp_path);assert value['source_sha']=='a'*40
    assert verified_build(build,backend)['source_sha']=='a'*40

def test_changed_asset_build_id_or_backend_cannot_reuse_verified_label(tmp_path):
    build,backend=fixture(tmp_path);write_receipt(tmp_path)
    for path in [build/'server/page.js',build/'static/style.css',build/'BUILD_ID',backend/'main.py']:
        original=path.read_text();path.write_text(original+' changed')
        with pytest.raises(ValueError):verified_build(build,backend)
        path.write_text(original)
    assert verified_build(build,backend)['source_sha']=='a'*40

def test_missing_or_malformed_archive_evidence_never_falls_back_to_head(tmp_path):
    build,backend=fixture(tmp_path)
    with pytest.raises(FileNotFoundError):verified_build(build,backend)
    (tmp_path/'source.json').write_text(json.dumps({'sha':'not-a-commit'}))
    with pytest.raises(ValueError):write_receipt(tmp_path)

def test_next_mutable_public_response_cache_is_separate_from_immutable_code_and_private_cache_is_rejected(tmp_path):
    build,backend=fixture(tmp_path);write_receipt(tmp_path)
    public=build/'server/route-cache/APP_PAGE/synthetic/$/login.html';public.parent.mkdir(parents=True);public.write_text('synthetic runtime public response')
    value=verified_build(build,backend);assert value['observed_runtime_cache_paths']==['server/route-cache/APP_PAGE/synthetic/$/login.html']
    private=build/'server/route-cache/APP_PAGE/synthetic/$/console/profile.html';private.parent.mkdir();private.write_text('synthetic private response must not qualify')
    with pytest.raises(ValueError,match='private route'):verified_build(build,backend)
