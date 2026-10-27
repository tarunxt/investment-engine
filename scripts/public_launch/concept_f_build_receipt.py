"""Local QA build/source binding. Never a deployment, attestation authority or startup override."""
import hashlib,json,re
from pathlib import Path

NAME='concept-f-build-receipt.json'

def tree_hash(root,kind):
    root=Path(root);paths=[]
    if kind=='backend':paths=sorted(root.rglob('*.py'))
    elif kind=='assets':
        paths=sorted({*root.glob('*.json'),root/'BUILD_ID',*(root/'server').rglob('*'),*(root/'static').rglob('*')})
        paths=[p for p in paths if p.name!=NAME and p.is_file() and p.relative_to(root).parts[:2]!=('server','route-cache')]
    else:raise ValueError('Known evidence tree required')
    if not paths:raise ValueError('Missing evidence tree')
    result=hashlib.sha256()
    for path in paths:
        if path.is_symlink():raise ValueError('Symlinked evidence file is unsupported')
        data=path.read_bytes();result.update(path.relative_to(root).as_posix().encode()+b'\0'+hashlib.sha256(data).digest())
    return result.hexdigest()

def write_receipt(root,*,created_after_build=False):
    root=Path(root);source=json.loads((root/'source.json').read_text())['sha']
    if not isinstance(source,str) or not re.fullmatch('[a-f0-9]{40}',source):raise ValueError('Explicit committed archive source required')
    build=root/'frontend/.next';identifier=(build/'BUILD_ID').read_text().strip()
    if not identifier:raise ValueError('Completed build required')
    value={'schema_version':2,'excluded_mutable_tree':'server/route-cache (Next runtime response cache; observed separately)','source_sha':source,'build_id':identifier,'asset_tree_sha256':tree_hash(build,'assets'),'backend_source_tree_sha256':tree_hash(root/'backend/app','backend'),'created_after_build':created_after_build,'kind':'local_qa_build_binding_not_hosted_release_evidence'}
    (build/NAME).write_text(json.dumps(value,sort_keys=True,indent=2)+'\n');return value

def verified_build(build,backend):
    build=Path(build);value=json.loads((build/NAME).read_text())
    if value.get('schema_version')!=2 or not re.fullmatch('[a-f0-9]{40}',str(value.get('source_sha',''))):raise ValueError('Exact archive source binding required')
    if value.get('build_id')!=(build/'BUILD_ID').read_text().strip() or value.get('asset_tree_sha256')!=tree_hash(build,'assets'):raise ValueError('Compiled build/source evidence changed')
    if value.get('backend_source_tree_sha256')!=tree_hash(backend,'backend'):raise ValueError('Runtime backend differs from compiled source archive')
    cache=build/'server/route-cache';observed=[]
    for path in sorted(cache.rglob('*')) if cache.exists() else []:
        if not path.is_file():continue
        relative=path.relative_to(build).as_posix();observed.append(relative)
        if path.is_symlink() or path.suffix in {'.js','.cjs','.mjs','.css'} or any('/$/'+prefix in relative.lower() for prefix in ('console','api/','backend-api','account/','me/','jobs/','runs/')):
            raise ValueError('Unexpected executable or known private route in runtime response cache')
    return {**value,'observed_runtime_cache_paths':observed}
