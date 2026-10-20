import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function load(path, bindings = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', ...Object.keys(bindings), output)(module.exports, module, ...Object.values(bindings));
  return module.exports;
}
function memoryStorage() {
  const values = new Map();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value),
    removeItem: key => values.delete(key), clear: () => values.clear(), values };
}
test('private persisted resources are owner-scoped across reloads/tabs and stale writers', () => {
  const window = { localStorage:memoryStorage(), sessionStorage:memoryStorage() };
  const a = load('../lib/privateBrowserStorage.ts', {window});
  assert.equal(a.privateLocalStorage.getItem('jobs:7'), null);
  assert.equal(a.setPrivateStorageOwner(1), true);
  a.privateLocalStorage.setItem('jobs:7', 'A private');
  a.privateSessionStorage.setItem('run:8', 'A run');
  const b = load('../lib/privateBrowserStorage.ts', {window});
  assert.equal(b.setPrivateStorageOwner(2), true);
  assert.equal(b.privateLocalStorage.getItem('jobs:7'), null);
  assert.equal(b.privateSessionStorage.getItem('run:8'), null);
  b.privateLocalStorage.setItem('jobs:7', 'B private');
  a.privateLocalStorage.setItem('jobs:7', 'late A write');
  assert.equal(b.privateLocalStorage.getItem('jobs:7'), 'B private');
  assert.equal(a.setPrivateStorageOwner(2), false, 'identity cannot be adopted by an old document');
  a.clearPrivateStorageOwner();
  a.privateLocalStorage.setItem('jobs:7', 'late after logout');
  assert.equal(a.privateLocalStorage.getItem('jobs:7'), null);
  assert.equal(b.privateLocalStorage.getItem('jobs:7'), 'B private');
  assert.equal(b.isPrivateStorageEvent({storageArea:window.localStorage,
    key:'investment-engine:private:v1:1:jobs:7'}, 'jobs:7'), false);
});

for (const cancellable of [false, true]) test(`late A request cannot populate B state (signal=${cancellable})`, async () => {
  const { PrivateRequestDeduplicator } = load('../lib/privateRequestDeduplicator.ts');
  const cache = new PrivateRequestDeduplicator();
  cache.setSessionGeneration('user:1:session:A');
  let resolve;
  const result = new Promise(done => { resolve = done; });
  const pending = cache.run({method:'GET',url:'/jobs/7', ...(cancellable ? {signal:new AbortController().signal} : {})}, () => result);
  const rejected = assert.rejects(pending, {name:'AbortError'});
  cache.setSessionGeneration('user:2:session:B');
  assert.equal(await cache.run({method:'GET',url:'/jobs/7'}, async () => 'B'), 'B');
  resolve('A private');
  await rejected;
});

function socketFixture(fetchImpl = async () => ({ok:true,json:async () => ({ticket:'synthetic-one-use-ticket'})})) {
  const registry = load('../services/privateSocketRegistry.ts');
  const sockets = [], timers = new Map(), events = [];
  let timerId = 0, fetches = 0;
  class Socket {
    constructor(url) { this.url=url; sockets.push(this); }
    close(code=1000) { this.closed=code; this.onclose?.({code}); }
  }
  const api = load('../services/websocket.ts', {
    require: path => {
      assert.equal(path, './privateSocketRegistry');
      return registry;
    },
    WebSocket:Socket, fetch:(...args) => { fetches++; return fetchImpl(...args); },
    setTimeout: fn => { timers.set(++timerId,fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    window:{dispatchEvent:event => events.push(event.type)},
  });
  return {...api, sockets,timers,events, get fetches(){return fetches;}};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('duplicate connects share one ticket; closing blocks late frames and pending reconnects', async () => {
  const f = socketFixture();
  const messages = [];
  const client = new f.WSClient({url:'ws://localhost/ws/jobs',onMessage:data => messages.push(data)});
  client.connect(); client.connect();
  await settle();
  assert.equal(f.fetches,1); assert.equal(f.sockets.length,1);
  const old = f.sockets[0]; old.onopen();
  old.onmessage({data:JSON.stringify({type:'job.updated',job_id:1})});
  assert.equal(messages.length,1);
  f.closePrivateWebSockets();
  old.onmessage({data:JSON.stringify({type:'job.updated',response:'late A'})});
  old.onclose({code:1006});
  assert.equal(messages.length,1); assert.equal(f.timers.size,0);
});
test('account loss while ticket is pending aborts it and never opens a socket', async () => {
  let finish, signal;
  const f = socketFixture((_url,options) => { signal=options.signal; return new Promise(resolve => {finish=resolve;}); });
  const client = new f.WSClient({url:'ws://localhost/ws/runs',onMessage:()=>assert.fail('late event')});
  client.connect(); f.closePrivateWebSockets();
  assert.equal(signal.aborted,true);
  finish({ok:true,json:async()=>({ticket:'old-A-ticket'})});
  await settle(); assert.equal(f.sockets.length,0);
});
test('transport/access-expiry reconnect obtains a fresh ticket without duplicate subscribers', async () => {
  const f = socketFixture();
  const client = new f.WSClient({url:'ws://localhost/ws/jobs',onMessage:()=>{}});
  client.connect(); await settle();
  f.sockets[0].onclose({code:4002});
  assert.equal(f.timers.size,1);
  [...f.timers.values()][0](); client.connect(); await settle();
  assert.equal(f.fetches,2); assert.equal(f.sockets.length,2);
  f.closePrivateWebSockets();
});
test('revoked session closes all clients and signals immediate private UI cleanup', async () => {
  const f = socketFixture();
  const a = new f.WSClient({url:'ws://localhost/ws/jobs',onMessage:()=>{}});
  const b = new f.WSClient({url:'ws://localhost/ws/runs',onMessage:()=>{}});
  a.connect(); b.connect(); await settle();
  f.sockets[0].onclose({code:4001});
  assert.equal(f.sockets[1].closed,1000);
  assert.deepEqual(f.events,['private-session-revoked']);
  assert.equal(f.timers.size,0);
});

test('current HTTP session loss clears the private boundary; stale A failures cannot evict B', () => {
  const source = readFileSync(new URL('../services/api.ts',import.meta.url),'utf8');
  const ast = ts.createSourceFile('api.ts',source,ts.ScriptTarget.Latest,true);
  const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'apiServiceClass');
  const method = cls.members.find(node => node.name?.getText(ast) === 'handleSessionLoss');
  const output = ts.transpileModule(`class Harness { constructor(cache){this.readDeduplicator=cache;} ${method.getText(ast)} } exports.Harness=Harness;`,
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const events = [], module = {exports:{}};
  new Function('exports','window',output)(module.exports,{dispatchEvent:event=>events.push(event.type)});
  const instance = new module.exports.Harness({getSessionGeneration:()=> 'B'});
  instance.handleSessionLoss(401,'Session is no longer active','A');
  instance.handleSessionLoss(401,'Google Sheets not connected. Please connect first.','B');
  assert.equal(events.length,0);
  instance.handleSessionLoss(401,'Session is no longer active','B');
  assert.deepEqual(events,['private-session-revoked']);
});
