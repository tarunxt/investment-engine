"""Finite offline supervisor with killed/joined subprocess callback deadlines.

No host observers, systemctl, start path or default executor. An external monitor
for supervisor death and actual Linux resource enforcement remain deployment gates.
"""
import json
import math
import multiprocessing
import time
from unit_inventory import UAT_UNITS


def _worker(connection,fn,args):
    try:
        payload=json.dumps({'value':fn(*args)},allow_nan=False).encode()
        if len(payload)>4096:raise ValueError()
    except Exception as e:
        payload=json.dumps({'error':type(e).__name__}).encode()
    try:connection.send_bytes(payload)
    finally:connection.close()


def bounded_call(fn,args,timeout):
    if not 0<timeout<=2:raise ValueError('invalid callback deadline')
    ctx=multiprocessing.get_context('spawn')
    receive,send=ctx.Pipe(duplex=False)
    process=ctx.Process(target=_worker,args=(send,fn,args),daemon=True)
    started=time.monotonic();result={}
    try:
        process.start();send.close()
        if receive.poll(timeout):result=json.loads(receive.recv_bytes(8192))
        else:result={'error':'Timeout'}
    except Exception as e:result={'error':type(e).__name__}
    finally:
        receive.close();send.close()
        if process.pid is not None:
            process.join(.05)
            if process.is_alive():process.terminate();process.join(.1)
            if process.is_alive():process.kill();process.join(.2)
            result['child_reaped']=not process.is_alive()
            if result['child_reaped']:process.close()
        else:result['child_reaped']=True
        result['started_monotonic']=started
        result['ended_monotonic']=time.monotonic()
    return result


def stopped_inventory(value):
    return (isinstance(value,dict) and set(value)==set(UAT_UNITS) and
        all(isinstance(s,dict) and s.get('Id')==name and s.get('ActiveState')=='inactive'
            and type(s.get('MainPID')) is int and s['MainPID']==0
            and s.get('cgroup_empty') is True for name,s in value.items()))


def run_finite(*,observe,stop,observe_stopped,cycles=3,interval=.05,timeout=1,total_seconds=10):
    if (type(cycles) is not int or not 1<=cycles<=60 or
            not all(type(x) in (int,float) and math.isfinite(x) for x in (interval,timeout,total_seconds)) or
            not 0<=interval<=1 or not 0<timeout<=2 or not 0<total_seconds<=30):
        raise ValueError('invalid finite supervisor configuration')
    end=time.monotonic()+total_seconds
    reports=[];reason='finite_window_complete'
    try:
        for _ in range(cycles):
            remaining=end-time.monotonic()
            if remaining<=0:reason='whole_window_deadline';break
            r=bounded_call(observe,(),min(timeout,remaining));reports.append(r)
            if (r.get('error') or not r['child_reaped'] or not isinstance(r.get('value'),dict)
                    or r['value'].get('status')!='PASS'):
                reason='observer_failed_or_gate_rejected';break
            remaining=end-time.monotonic()
            if remaining>0:time.sleep(min(interval,remaining))
    except Exception:
        reason='supervisor_exception'
    finally:
        # Always stop only the canonical UAT inventory, including on completion.
        stop_result=bounded_call(stop,(UAT_UNITS,),timeout)
        cleanup=bounded_call(observe_stopped,(UAT_UNITS,),timeout)
    confirmed=(stop_result.get('child_reaped') and cleanup.get('child_reaped') and
               not cleanup.get('error') and stopped_inventory(cleanup.get('value')))
    return {'reason':reason,'observations':reports,'stop':stop_result,'cleanup':cleanup,
            'status':'STOPPED' if confirmed else 'STOP_UNCONFIRMED',
            'operator_required':not confirmed,'activation_authorized':False}
