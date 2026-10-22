"""Installed Kombu implementation probe; no listener, Redis or simulated service acceptance."""
from contextlib import nullcontext
from types import SimpleNamespace
import kombu.transport.redis as transport


def test_real_kombu_visibility_timeout_is_not_restore_poll_interval(monkeypatch):
    clock=[1.0];queries=[];restored=[]
    class Client:
        def zrevrangebyscore(self,key,ceiling,*args,**kwargs):
            queries.append(ceiling)
            return [('owned-tag',0.0)] if ceiling>=0 else []
    client=Client()
    channel=SimpleNamespace(conn_or_acquire=lambda:nullcontext(client),visibility_timeout=2,
        unacked_index_key='private-index',unacked_mutex_key='private-mutex',unacked_mutex_expire=3)
    qos=object.__new__(transport.QoS);qos.channel=channel;qos._vrestore_count=0
    qos.restore_by_tag=lambda tag,client:restored.append(tag)
    monkeypatch.setattr(transport,'time',lambda:clock[0])
    monkeypatch.setattr(transport,'Mutex',lambda *args,**kwargs:nullcontext())
    qos.restore_visible()  # Actual startup implementation: not yet expired.
    assert len(queries)==1 and not restored
    clock[0]=31.0
    for _ in range(9):qos.restore_visible()
    assert len(queries)==1 and not restored  # Expiry alone did not cause a scan.
    qos.restore_visible()
    assert restored==['owned-tag'] and len(queries)==2
    restored.clear();queries.clear();qos._vrestore_count=0;clock[0]=1
    qos.restore_visible();clock[0]=31
    qos.restore_visible(interval=1)  # Normal explicit recovery path, no timestamp mutation.
    assert restored==['owned-tag'] and len(queries)==2
