"""Snapshot/restore the entire backend application source, excluding runtime data.

Run under the production deployment lock with both consumers stopped for restore.
This helper neither connects to a database nor reads/changes environment files.
Backups and failed candidate source are retained; credentials/venv stay in place.
"""
from __future__ import annotations
import argparse
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
from uuid import uuid4

DIRECTORIES=("backend/app","backend/scripts","backend/alembic","deploy/no-docker")
ROOT_SUFFIXES={".py",".ini",".txt",".toml",".json",".yaml",".yml"}
MAX_BYTES=512*1024*1024


def tracked_sources(app_root):
    result=subprocess.run(["git","-C",str(app_root),"ls-files","-z","--","backend","deploy/no-docker"],check=True,capture_output=True,timeout=10)
    names={name.decode("utf-8") for name in result.stdout.split(b"\0") if name}
    if len(names)>20000 or any(PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts for name in names): raise ValueError("Invalid tracked source manifest")
    return names


def root_sources(app_root, tracked):
    return sorted(app_root/name for name in tracked if len(PurePosixPath(name).parts)==2 and PurePosixPath(name).parts[0]=="backend" and PurePosixPath(name).suffix in ROOT_SUFFIXES and not PurePosixPath(name).name.startswith(".env"))


def checked_files(app_root, tracked, *, require_complete=True):
    paths=[]
    for name in DIRECTORIES:
        directory=app_root/name
        if directory.is_symlink(): raise ValueError("Source directory is a symlink")
        if directory.exists():
            for path in sorted(directory.rglob("*")):
                if path.is_symlink(): raise ValueError("Source symlink blocks a complete safe snapshot")
                if path.is_file() and "__pycache__" not in path.parts and path.suffix!=".pyc": paths.append(path)
    paths+=root_sources(app_root,tracked)
    if require_complete and any(not (app_root/name).is_file() for name in tracked if safe_member(name)):
        raise ValueError("Tracked source file unavailable; complete snapshot blocked")
    for path in paths:
        if path.is_symlink() or path.name.startswith(".env") or path.suffix in {".pem",".key",".p12"}:
            raise ValueError("Credential-like source path blocks snapshot; no credential file read")
        if path.relative_to(app_root).as_posix() not in tracked: raise ValueError("Untracked content in a replaced source directory blocks snapshot before reading files")
        if not path.exists() and not require_complete: continue
        if not path.is_file(): raise ValueError("Tracked source file unavailable")
    paths=[path for path in paths if path.exists()]
    if sum(p.stat().st_size for p in paths)>MAX_BYTES: raise ValueError("Backend artifact exceeds bounded size")
    return paths


def snapshot(app_root, destination, previous_sha):
    app_root=Path(app_root).resolve();destination=Path(destination).resolve()
    if len(previous_sha)!=40 or any(c not in "0123456789abcdef" for c in previous_sha): raise ValueError("Invalid previous SHA")
    backend=app_root/"backend"
    if backend.is_symlink() or destination.is_relative_to(backend) or any(destination.is_relative_to(app_root/name) for name in DIRECTORIES): raise ValueError("Unsafe artifact location")
    paths=checked_files(app_root,tracked_sources(app_root))
    if not any(p.is_relative_to(backend/"app") for p in paths): raise ValueError("No complete backend app found")
    destination.mkdir(mode=0o700,parents=True,exist_ok=False)
    archive=destination/"backend-source.tar.gz"
    hashes={}
    with tarfile.open(archive,"w:gz") as target:
        for path in paths:
            name=path.relative_to(app_root).as_posix();data=path.read_bytes()
            hashes[name]=hashlib.sha256(data).hexdigest()
            info=target.gettarinfo(str(path),arcname=name);info.size=len(data)
            target.addfile(info,BytesIO(data))
    os.chmod(archive,0o600)
    manifest={"schema":1,"app_root":str(app_root),"previous_sha":previous_sha,"archive_sha256":hashlib.sha256(archive.read_bytes()).hexdigest(),"files":hashes}
    (destination/"manifest.json").write_text(json.dumps(manifest,sort_keys=True)+"\n")
    os.chmod(destination/"manifest.json",0o600)
    return manifest


def safe_member(name):
    path=PurePosixPath(name)
    covered=any(path.is_relative_to(PurePosixPath(directory)) and path!=PurePosixPath(directory) for directory in DIRECTORIES)
    root_file=len(path.parts)==2 and path.parts[0]=="backend" and path.suffix in ROOT_SUFFIXES and not path.name.startswith(".env")
    return not path.is_absolute() and ".." not in path.parts and not path.name.startswith(".env") and path.suffix not in {".pem",".key",".p12"} and (covered or root_file)


def restore(app_root, destination):
    app_root=Path(app_root).resolve();destination=Path(destination).resolve();backend=app_root/"backend"
    manifest=json.loads((destination/"manifest.json").read_text());archive=destination/"backend-source.tar.gz"
    if manifest.get("schema")!=1 or manifest.get("app_root")!=str(app_root): raise ValueError("Artifact target mismatch")
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=manifest["archive_sha256"]: raise ValueError("Artifact checksum mismatch")
    if backend.is_symlink(): raise ValueError("Backend is a symlink")
    current_tracked=tracked_sources(app_root)
    checked_files(app_root,current_tracked,require_complete=False)  # Validate extant candidate paths; a partial checkout must remain recoverable.
    stage=destination/("restore-"+uuid4().hex);stage.mkdir(mode=0o700)
    with tarfile.open(archive,"r:gz") as source:
        members=source.getmembers()
        names=[item.name for item in members]
        if len(set(names))!=len(names) or set(names)!=set(manifest["files"]): raise ValueError("Artifact member mismatch")
        if sum(item.size for item in members)>MAX_BYTES: raise ValueError("Artifact size bound exceeded")
        for item in members:
            if not item.isfile() or not safe_member(item.name): raise ValueError("Unsafe artifact member")
            path=stage/item.name;path.parent.mkdir(parents=True,exist_ok=True)
            with source.extractfile(item) as stream,path.open("wb") as target: shutil.copyfileobj(stream,target)
            os.chmod(path,item.mode & 0o777)
            if hashlib.sha256(path.read_bytes()).hexdigest()!=manifest["files"][item.name]: raise ValueError("Source checksum mismatch")
    # Validate every byte before replacing live application code. New candidate
    # files disappear from the runtime but remain in this private failed artifact.
    failed=destination/("failed-candidate-"+uuid4().hex);failed.mkdir(mode=0o700)
    for name in DIRECTORIES:
        live=app_root/name;incoming=stage/name
        (failed/name).parent.mkdir(parents=True,exist_ok=True)
        live.parent.mkdir(parents=True,exist_ok=True)
        if live.exists(): os.replace(live,failed/name)
        if incoming.exists(): os.replace(incoming,live)
    (failed/"backend").mkdir(exist_ok=True)
    for path in root_sources(app_root,current_tracked):
        if path.exists(): os.replace(path,failed/"backend"/path.name)
    if (stage/"backend").exists():
        for name in manifest["files"]:
            path=PurePosixPath(name)
            if len(path.parts)==2 and path.parts[0]=="backend": os.replace(stage/name,app_root/name)
    return manifest


if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("operation",choices=["snapshot","restore"])
    parser.add_argument("app_root");parser.add_argument("destination");parser.add_argument("--previous-sha")
    args=parser.parse_args()
    result=snapshot(args.app_root,args.destination,args.previous_sha or "") if args.operation=="snapshot" else restore(args.app_root,args.destination)
    print(json.dumps({"operation":args.operation,"backend_artifact_sha":result["previous_sha"],"source_file_count":len(result["files"])}))
