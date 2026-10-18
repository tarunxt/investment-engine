"""Filesystem/process fixtures only; no Docker, systemd or network operations."""
import copy
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch
SPEC=importlib.util.spec_from_file_location('reviewed_runtime_watcher',Path(__file__).resolve().parents[1]/'runtime/runtime_watcher.py')
w=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(w)
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'runtime'))
import live_watch as entrypoint

class FakePath:
    files={};modes={}
    def __init__(self,*parts):self.value='/'.join(str(p).rstrip('/') for p in parts)
    def __truediv__(self,value):return FakePath(self.value,str(value))
    def __str__(self):return self.value
    @property
    def parent(self):return FakePath(self.value.rsplit('/',1)[0])
    def read_text(self):return self.files[self.value]
    def stat(self):return NS(st_mode=self.modes.get(self.value,0o444))
    def rglob(self,pattern):return [FakePath(p)for p in self.files if p.startswith(self.value+'/')and p.endswith('/'+pattern)]

class RuntimeWatcherTests(unittest.TestCase):
    def setUp(self):
        self.cg='/credx.slice/credx-uat.slice';self.root=FakePath('/fixture/runtime');self.runroot=FakePath('/fixture/run');self.cgroot=FakePath('/sys/fs/cgroup'+self.cg)
        self.context=NS(ROOT=self.root,RUN=self.runroot,CGROOT=self.cgroot,CG=self.cg,NAMES=['fixture-db','fixture-cache','fixture-app'],UNITS=['credx-uat-live-supervisor.service'],run=self.fake_run,docker=lambda *args:['docker',*args],write=Mock(),guard=Mock())
        hc=dict(NetworkMode='none',PortBindings={},ReadonlyRootfs=True,CgroupParent=self.cg+'/credx-uat-lab.slice')
        self.containers=[dict(State=dict(Running=True,Pid=n),HostConfig=copy.deepcopy(hc),Config={'Env':[]},Image='fixture-image')for n in [10,20,30]]
        self.test=dict(Name='/credx-uat-live-tests',Image='fixture-image',State=dict(Running=True,Pid=40),HostConfig=dict(hc,Privileged=False,CapDrop=['ALL'],SecurityOpt=['no-new-privileges'],Memory=268435456,MemorySwap=268435456,NanoCpus=500000000,PidsLimit=64),Config=dict(User='0:19992',Cmd=['python','/runtime/live_private_tests.py'],Env=[]),Mounts=[dict(Source=str(self.root/'runtime'),Destination='/runtime',RW=False),dict(Source=str(self.root/'jwks/synthetic'),Destination='/jwks/synthetic',RW=True),dict(Source=str(self.runroot/'http'),Destination='/http',RW=True),dict(Source=str(self.runroot/'private-tests'),Destination='/test-control',RW=True)])
        self.config={'io_max':'fixture-device-limit','stop_epoch':1100}
        values={'memory.max':'2147483648','memory.swap.max':'0','cpu.max':'150000 100000','pids.max':'512','io.max':'fixture-device-limit','memory.events':'oom 0\noom_kill 0','memory.current':'100','memory.peak':'200'}
        FakePath.files={str(self.cgroot/k):v for k,v in values.items()};FakePath.modes={}
        self.links={'/proc/self/ns/net':'net:[host]'}
        for n in [10,20,30,40]:
            group=self.cg+'/credx-uat-lab.slice/fixture-'+str(n)
            FakePath.files['/proc/'+str(n)+'/cgroup']='0::'+group
            FakePath.files['/sys/fs/cgroup'+group+'/cgroup.procs']=str(n)
            base='/proc/'+str(n)+'/net/'
            FakePath.files.update({base+'dev':'header\nheader\nlo: counters',base+'route':'header',base+'ipv6_route':'',base+'unix':'header'})
            self.links['/proc/'+str(n)+'/ns/net']='net:['+str(n)+']'
        fields=['S']+['0']*18+['7'];FakePath.files['/proc/90/stat']='90 (fixture) '+' '.join(fields)
        unitgroup=self.cg+'/credx-uat-private-tests.service'
        FakePath.files['/sys/fs/cgroup'+unitgroup+'/cgroup.procs']='91'
        self.fs=NS(f_bavail=2**22,f_frsize=1024,f_favail=60000)
        self.observer=w.RuntimeWatcher(self.context)
        self.observer.owned=Mock(return_value=dict(pid=90,start_ticks=7,monotonic=1000))
    def fake_run(self,args,**kw):
        if args[:2]==['docker','inspect']:
            return NS(returncode=0,stdout=json.dumps([self.test] if args[2:]==['credx-uat-live-tests']else self.containers))
        if 'ActiveState'in args:return NS(returncode=0,stdout='active\n'*5)
        return NS(returncode=0,stdout=self.cg+'/credx-uat-private-tests.service' if args[-1]=='credx-uat-private-tests.service' else '')
    def observe(self):
        with patch.object(w,'Path',FakePath),patch.object(w.os,'readlink',side_effect=lambda p:self.links[str(p)]),patch.object(w.os,'statvfs',return_value=self.fs),patch.object(w.time,'monotonic',return_value=1000):
            return self.observer.observation(self.config)
    def test_exact_test_consumer_and_unit_count_in_aggregate_inventory(self):
        result=self.observe();self.assertEqual(result['pids'],[10,20,30,40,91]);self.assertEqual(len(result['network_namespaces']),4)
        self.assertTrue(result['all_processes_accounted']);self.assertTrue(result['isolation_verified'])
    def test_test_identity_image_user_command_and_limits_cannot_broaden(self):
        changes=[('Name','other'),('Image','different'),('Config.User','other'),('Config.Cmd',['other']),('HostConfig.Privileged',True),('HostConfig.CapDrop',[]),('HostConfig.SecurityOpt',[]),('HostConfig.Memory',1),('HostConfig.MemorySwap',1),('HostConfig.NanoCpus',1),('HostConfig.PidsLimit',1),('HostConfig.NetworkMode','host'),('HostConfig.ReadonlyRootfs',False)]
        original=copy.deepcopy(self.test)
        for key,value in changes:
            self.test=copy.deepcopy(original);target=self.test;parts=key.split('.')
            for part in parts[:-1]:target=target[part]
            target[parts[-1]]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.observe()
    def test_extra_or_mutated_mount_denied(self):
        self.test['Mounts'].append(dict(Source='/other',Destination='/other',RW=True))
        with self.assertRaisesRegex(ValueError,'mounts'):self.observe()
        self.test['Mounts'].pop();self.test['Mounts'][0]['RW']=True
        with self.assertRaisesRegex(ValueError,'mounts'):self.observe()
    def test_all_containers_require_distinct_nonhost_namespaces(self):
        self.links['/proc/40/ns/net']=self.links['/proc/30/ns/net']
        with self.assertRaisesRegex(ValueError,'shared'):self.observe()
        self.links['/proc/40/ns/net']=self.links['/proc/self/ns/net']
        with self.assertRaisesRegex(ValueError,'host network'):self.observe()
    def test_unknown_aggregate_process_still_fails_closed(self):
        FakePath.files['/sys/fs/cgroup'+self.cg+'/unknown/cgroup.procs']='99'
        with self.assertRaisesRegex(ValueError,'unaccounted'):self.observe()
    def test_unreadable_metric_and_disk_below_four_gib_denied(self):
        FakePath.modes[str(self.cgroot/'memory.current')]=0
        with self.assertRaisesRegex(ValueError,'unreadable'):self.observe()
        FakePath.modes={};self.fs.f_bavail=2**22-1
        with self.assertRaisesRegex(ValueError,'disk reserve'):self.observe()
    def test_effective_aggregate_limits_not_weakened_by_test_allowance(self):
        for key,value in [('memory.max','1'),('cpu.max','other'),('memory.swap.max','1'),('pids.max','513'),('io.max','other'),('memory.events','oom_kill 1')]:
            path=str(self.cgroot/key);old=FakePath.files[path];FakePath.files[path]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.observe()
            FakePath.files[path]=old
    def test_actual_monitor_entrypoint_uses_observation_and_fails_closed(self):
        self.observer.owned=Mock(return_value=self.config);self.observer.notify=Mock()
        self.observer.observation=Mock(side_effect=ValueError('fixture metric unavailable'))
        with patch.object(w,'RuntimeWatcher',return_value=self.observer),patch.object(w.time,'time',return_value=1000),self.assertRaises(SystemExit):
            with patch.object(entrypoint,'watch_runtime',side_effect=w.watch_runtime):
                entrypoint.main(['monitor'],runtime=self.context)
        self.observer.observation.assert_called_once_with(self.config)
        self.context.write.assert_called_once();self.assertIn('FAIL_CLOSED',self.context.write.call_args.args[1])
    def test_invalid_entrypoint_mode_never_invokes_host_commands(self):
        self.context.run=Mock(side_effect=AssertionError('host forbidden'))
        with self.assertRaises(ValueError):w.watch_runtime(self.context,'other')
        self.context.run.assert_not_called()
