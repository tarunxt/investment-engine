"""Independent systemd watchdog and direct cgroup/namespace observer."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

class RuntimeWatcher:
    """Root-owned caller supplies fixed runtime bindings; construction performs no I/O.

    Keeps the live observer algorithm, with explicit dependencies for source/CI
    use. Runtime bindings are trusted host code, never HTTP or receipt inputs.
    """
    def __init__(self, runtime):
        required = ('ROOT','RUN','CGROOT','CG','NAMES','UNITS','run','docker','write','guard')
        if any(not hasattr(runtime, name) for name in required):
            raise ValueError('incomplete runtime bindings')
        if len(runtime.NAMES) != 3 or len(set(runtime.NAMES)) != 3:
            raise ValueError('fixed service container inventory required')
        self.runtime = runtime

    def owned(self,path):
        ROOT,RUN,CGROOT,CG,NAMES,UNITS,run,docker,write,guard = (getattr(self.runtime,n) for n in ('ROOT','RUN','CGROOT','CG','NAMES','UNITS','run','docker','write','guard'))
        p=Path(path);s=p.lstat()
        if not p.is_file() or p.is_symlink() or s.st_uid!=0 or s.st_mode&0o077 or s.st_size>8192:raise ValueError('untrusted receipt')
        return json.loads(p.read_text())
    def notify(self,message):
        ROOT,RUN,CGROOT,CG,NAMES,UNITS,run,docker,write,guard = (getattr(self.runtime,n) for n in ('ROOT','RUN','CGROOT','CG','NAMES','UNITS','run','docker','write','guard'))
        address=os.environ['NOTIFY_SOCKET']
        if address.startswith('@'):address='\0'+address[1:]
        with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as s:s.settimeout(.2);s.connect(address);s.sendall(message.encode())
    def heartbeat(self):
        ROOT,RUN,CGROOT,CG,NAMES,UNITS,run,docker,write,guard = (getattr(self.runtime,n) for n in ('ROOT','RUN','CGROOT','CG','NAMES','UNITS','run','docker','write','guard'))
        session=guard();pid=os.getpid();fields=Path('/proc/self/stat').read_text().split(') ',1)[1].split()
        while time.time()<session['stop_epoch']:
            temporary=RUN/'supervisor.next'
            write(temporary,json.dumps({'pid':pid,'start_ticks':int(fields[19]),'monotonic':time.monotonic()}));os.replace(temporary,RUN/'supervisor.json');time.sleep(.25)

    def observation(self,config):
        ROOT,RUN,CGROOT,CG,NAMES,UNITS,run,docker,write,guard = (getattr(self.runtime,n) for n in ('ROOT','RUN','CGROOT','CG','NAMES','UNITS','run','docker','write','guard'))
        if not (CGROOT/'memory.current').stat().st_mode&0o400:raise ValueError('unreadable kernel memory metric')
        values={name:(CGROOT/name).read_text().strip() for name in ['memory.max','memory.swap.max','cpu.max','pids.max','io.max','memory.events','memory.current','memory.peak']}
        expected={'memory.max':'2147483648','memory.swap.max':'0','cpu.max':'150000 100000','pids.max':'512'}
        if any(values[k]!=v for k,v in expected.items()):raise ValueError('aggregate limits mismatch')
        if not values['io.max'] or values['io.max']!=config['io_max']:raise ValueError('I/O enforcement mismatch')
        if int(dict(line.split() for line in values['memory.events'].splitlines()).get('oom_kill',-1))!=0:raise ValueError('OOM threshold')
        fs=os.statvfs(ROOT)
        if fs.f_bavail*fs.f_frsize<4294967296 or fs.f_favail<50000:raise ValueError('disk reserve')
        heartbeat=self.owned(RUN/'supervisor.json')
        if not 0<=time.monotonic()-heartbeat['monotonic']<=2:raise ValueError('stale supervisor')
        ps=Path('/proc',str(heartbeat['pid']),'stat').read_text().split(') ',1)[1].split()
        if ps[0] in ('Z','X') or int(ps[19])!=heartbeat['start_ticks']:raise ValueError('dead supervisor')
        state=run(['systemctl','show','-p','ActiveState','--value','credx-uat-backend.service','credx-uat-db.service','credx-uat-redis.service','credx-uat-frontend.service','credx-uat-key-carrier.service'],timeout=1)
        if state.stdout.split()!=['active']*5:raise ValueError('service unhealthy')
        containers=json.loads(run(docker('inspect',*NAMES),timeout=1.5).stdout)
        optional=run(docker('inspect','credx-uat-live-tests'),timeout=1.5,check=False)
        if optional.returncode==0:
            test=json.loads(optional.stdout)[0]
            if test['State']['Running']:
                hc=test['HostConfig'];cfg=test['Config']
                if test['Name']!='/credx-uat-live-tests' or test['Image']!=containers[2]['Image'] or cfg['User']!='0:19992' or cfg['Cmd']!=['python','/runtime/live_private_tests.py']:raise ValueError('private test identity denied')
                if hc['Privileged'] or hc['CapDrop']!=['ALL'] or hc['SecurityOpt']!=['no-new-privileges'] or [hc[k] for k in ['Memory','MemorySwap','NanoCpus','PidsLimit']]!=[268435456,268435456,500000000,64]:raise ValueError('private test limits denied')
                wanted={(str(ROOT/'runtime'),'/runtime',False),(str(ROOT/'jwks/synthetic'),'/jwks/synthetic',True),(str(RUN/'http'),'/http',True),(str(RUN/'private-tests'),'/test-control',True)}
                if {(m['Source'],m['Destination'],m['RW']) for m in test['Mounts']}!=wanted:raise ValueError('private test mounts denied')
                containers.append(test)
        hostnet=os.readlink('/proc/self/ns/net');network_namespaces=[];roots=[]
        for record in containers:
            pid=record['State']['Pid'];hc=record['HostConfig']
            if not record['State']['Running'] or pid<=1 or hc['NetworkMode']!='none' or hc.get('PortBindings') or not hc['ReadonlyRootfs'] or hc['CgroupParent']!=CG+'/credx-uat-lab.slice':raise ValueError('container isolation')
            if record['Config']['Env'] and any(x.startswith(('AWS_','UAT_SIGNING_KEY=')) for x in record['Config']['Env']):raise ValueError('credential configuration leak')
            path=Path('/proc',str(pid));group=next(line.split(':',2)[2] for line in (path/'cgroup').read_text().splitlines() if line.startswith('0::'))
            if not group.startswith(CG+'/credx-uat-lab.slice/'):raise ValueError('container escaped aggregate')
            roots.append(group);ns=os.readlink(path/'ns/net');network_namespaces.append(ns)
            if ns==hostnet:raise ValueError('application host network')
            net=path/'net'
            if [line.split(':')[0].strip() for line in (net/'dev').read_text().splitlines()[2:]]!=['lo']:raise ValueError('external interface')
            if len((net/'route').read_text().splitlines())!=1:raise ValueError('external route')
            if any(line.split()[-1]!='lo' for line in (net/'ipv6_route').read_text().splitlines()):raise ValueError('IPv6 external route')
            for line in (net/'unix').read_text().splitlines()[1:]:
                fields=line.split()
                if len(fields)>=8 and fields[7] not in ['/pg/.s.PGSQL.5432','@/pg/.s.PGSQL.5432','/var/run/postgresql/.s.PGSQL.5432','@/var/run/postgresql/.s.PGSQL.5432','/redis/redis.sock','/http/http.sock']:raise ValueError('unreviewed Unix socket')
        if len(set(network_namespaces))!=len(containers):raise ValueError('shared service network namespace')
        allowed=(*UNITS,'credx-uat-lab-docker.service','credx-uat-live-monitor.service','credx-uat-live-jwks.service','credx-uat-key-carrier.service','credx-uat-private-tests.service')
        cgroup_roots=[]
        for unit in allowed:
            p=run(['systemctl','show','-p','ControlGroup','--value',unit],timeout=1,check=False).stdout.strip()
            if p:cgroup_roots.append(p)
        processes={}
        for file in CGROOT.rglob('cgroup.procs'):
            group=str(file.parent).removeprefix('/sys/fs/cgroup')
            for raw in file.read_text().split():
                pid=int(raw)
                if not any(group==root or group.startswith(root+'/') for root in [*roots,*cgroup_roots]):raise ValueError('unaccounted aggregate process')
                processes[pid]=group
        if not processes:raise ValueError('empty inventory')
        return {'status':'PASS','observed_monotonic':time.monotonic(),'aggregate':values,'pids':sorted(processes),'network_namespaces':network_namespaces,'all_processes_accounted':True,'isolation_verified':True,'disk_free_bytes':fs.f_bavail*fs.f_frsize,'free_inodes':fs.f_favail}

    def monitor(self):
        ROOT,RUN,CGROOT,CG,NAMES,UNITS,run,docker,write,guard = (getattr(self.runtime,n) for n in ('ROOT','RUN','CGROOT','CG','NAMES','UNITS','run','docker','write','guard'))
        config=self.owned(ROOT/'watch.json');self.notify('READY=1')
        try:
            while time.time()<config['stop_epoch']:
                sample=self.observation(config);sample['time_utc']=datetime.now(timezone.utc).isoformat()
                write(ROOT/'last-runtime-observation.json',json.dumps(sample));self.notify('WATCHDOG=1');time.sleep(.25)
            raise ValueError('session deadline')
        except Exception as e:
            write(ROOT/'watch-failure.json',json.dumps({'status':'FAIL_CLOSED','failure_type':type(e).__name__,'reason':str(e)[:180],'time_utc':datetime.now(timezone.utc).isoformat()}));raise SystemExit(1)


def watch_runtime(runtime, mode):
    """Actual monitor/supervisor caller; no implicit host context or auto-start."""
    watcher = RuntimeWatcher(runtime)
    if mode == 'monitor':
        return watcher.monitor()
    if mode == 'supervisor':
        return watcher.heartbeat()
    raise ValueError('watch mode denied')
