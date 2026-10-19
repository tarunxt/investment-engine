#!/usr/bin/env python3
"""Secret-free bundle manifest and fail-closed archive verification."""
import hashlib
import json
import platform
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


def extract(archive, target):
    with tarfile.open(archive) as source:
        source.extractall(target, filter='data')


if __name__ == '__main__':
    create(Path(sys.argv[1]), sys.argv[2])
