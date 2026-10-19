#!/usr/bin/env python3
"""Secret-free bundle manifest and fail-closed archive verification."""
import hashlib
import json
import platform
import argparse
import subprocess
import tempfile
import os
import re
import sys
import tarfile
from pathlib import Path


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            value.update(block)
    return value.hexdigest()


def create(directory, source):
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('Full source commit required')
    files = [directory/'application.tar.gz', directory/'frontend.tar.gz', *sorted((directory/'wheels').glob('*.whl'))]
    if len(files) < 3:
        raise ValueError('Application/frontend archives and wheelhouse required')
    manifest = {'schema_version': 1, 'source_commit': source, 'runtime': 'native',
                'platform': 'linux', 'arch': 'x86_64', 'python': '3.12', 'node_major': 22,
                'files': {str(path.relative_to(directory)): digest(path) for path in files}}
    (directory/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    return manifest


def verify(directory):
    manifest = json.loads((directory/'manifest.json').read_text())
    if manifest.get('schema_version') != 1 or manifest.get('runtime') != 'native' or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('source_commit', '')):
        raise ValueError('Invalid UAT2 release manifest')
    if (manifest.get('platform'),manifest.get('arch'),manifest.get('python'),manifest.get('node_major')) != ('linux','x86_64','3.12',22):
        raise ValueError('Unsupported native release platform')
    files = manifest.get('files', {})
    if not {'application.tar.gz', 'frontend.tar.gz'}.issubset(files) or not any(name.startswith('wheels/') for name in files):
        raise ValueError('Incomplete native bundle')
    for name, expected in files.items():
        if not re.fullmatch(r'(application\.tar\.gz|frontend\.tar\.gz|wheels/[A-Za-z0-9_.+-]+\.whl)', name):
            raise ValueError('Unexpected bundle member')
        path = directory/name
        if path.is_symlink() or not path.is_file() or not re.fullmatch(r'[0-9a-f]{64}', expected) or digest(path) != expected:
            raise ValueError('Bundle checksum mismatch')
    return manifest


def audit(directory):
    """Inspect only expected bundle files and archives; never load runtime secrets."""
    manifest = verify(directory)
    root = directory.resolve()
    expected = set(manifest['files']) | {'manifest.json', 'frontend.tar.gz.sha256'}
    for path in directory.rglob('*'):
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('Symlinked or escaping bundle content rejected')
        if path.is_file() and str(path.relative_to(directory)) not in expected:
            raise ValueError('Unexpected retained bundle file')
    checksum = directory/'frontend.tar.gz.sha256'
    if checksum.exists() and checksum.read_text().split()[0] != manifest['files']['frontend.tar.gz']:
        raise ValueError('Frontend checksum sidecar mismatch')
    required_source = {'backend/requirements.txt', 'backend/app/uat2/main.py',
                       'deploy/uat2/native/ctl.py', 'deploy/uat2/native/package.py'}
    counts = {}
    for name in ['application.tar.gz', 'frontend.tar.gz']:
        with tarfile.open(directory/name) as archive:
            members = archive.getmembers()
            names = set()
            for member in members:
                normalized = member.name.removeprefix('./')
                tarfile.data_filter(member, str(root/'archive-audit'))
                if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                    raise ValueError('Special archive member rejected')
                base = Path(normalized).name
                if '.git' in Path(normalized).parts or (not base.endswith('.example') and
                    (base.startswith('.env') or base.endswith(('.env','.pem','.key','.p12','.pfx','.sqlite','.db','.dump')))):
                    raise ValueError('Runtime environment, credential or database artifact rejected')
                if name == 'application.tar.gz' and not (normalized.startswith('backend/') or normalized.startswith('deploy/uat2/native/') or normalized in {'backend','deploy','deploy/uat2','deploy/uat2/native','deploy/uat2/validate.py'}):
                    raise ValueError('Unexpected application source scope')
                names.add(normalized)
            counts[name] = len(members)
            if name == 'application.tar.gz' and not required_source.issubset(names):
                raise ValueError('Incomplete native application source')
            if name == 'frontend.tar.gz':
                by_name = {item.name.removeprefix('./'):item for item in members}
                if not {'server.js','deployment-manifest.json','.next/BUILD_ID','.next/server/app-paths-manifest.json'}.issubset(names):
                    raise ValueError('Incomplete standalone frontend')
                front = json.load(archive.extractfile(by_name['deployment-manifest.json']))
                public = front.get('public_environment',{})
                if (front.get('build_sha'),front.get('platform'),front.get('arch'),front.get('node_major')) != (manifest['source_commit'],'linux','x64',22):
                    raise ValueError('Frontend source/platform mismatch')
                if public.get('NEXT_PUBLIC_FRONTEND_URL') != 'https://uat2.cred-x.in' or public.get('NEXT_PUBLIC_DISABLE_AUTH') != 'false':
                    raise ValueError('Frontend UAT2 origin/authentication mismatch')
                routes = json.load(archive.extractfile(by_name['.next/server/app-paths-manifest.json']))
                if not any('/console/uat2/' in route for route in routes):
                    raise ValueError('Actual UAT2 application route missing')
    return {'source_commit':manifest['source_commit'], 'manifest_sha256':digest(directory/'manifest.json'),
            'files_verified':len(manifest['files']), 'wheel_count':sum(name.startswith('wheels/') for name in manifest['files']),
            'archives':counts, 'runtime_configuration_included':False}


def offline_check(directory):
    receipt = audit(directory)
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or sys.version_info[:2] != (3,12):
        raise ValueError('Offline dependency verification requires target Linux x86_64/Python3.12')
    with tempfile.TemporaryDirectory(prefix='uat2-retained-verify-') as temporary:
        target = Path(temporary)
        extract(directory/'application.tar.gz',target/'source')
        subprocess.run([sys.executable,'-m','venv',str(target/'venv')],check=True,timeout=60)
        env = dict(os.environ,PIP_NO_INDEX='1',PIP_DISABLE_PIP_VERSION_CHECK='1',PIP_CONFIG_FILE=os.devnull)
        subprocess.run([str(target/'venv/bin/pip'),'install','--no-index','--find-links',str(directory.resolve()/'wheels'),
                        '-r',str(target/'source/backend/requirements.txt')],check=True,env=env,stdout=sys.stderr,timeout=300)
        subprocess.run([str(target/'venv/bin/python'),'-c','import fastapi, sqlalchemy, celery, redis, google.auth'],check=True,env=env,timeout=30)
    return {**receipt,'offline_dependency_install':'passed'}


def extract(archive, target):
    with tarfile.open(archive) as source:
        source.extractall(target, filter='data')


if __name__ == '__main__':
    if sys.argv[1] in {'audit','offline-check'}:
        function = audit if sys.argv[1] == 'audit' else offline_check
        print(json.dumps(function(Path(sys.argv[2])),indent=2))
    else:
        create(Path(sys.argv[1]), sys.argv[2])
