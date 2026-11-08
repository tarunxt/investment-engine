import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createDatabaseViewerSocketFetcher, verifySocketMetadata } from '../lib/databaseViewerSocket.ts';

// The cloud filesystem exports / and /tmp with a mapped root UID. Simulate
// Linux root metadata for those ancestors only; socket/parent ACLs remain real.
const fetchDatabaseViewerSocket = createDatabaseViewerSocketFetcher(async name => {
  const entry = await lstat(name);
  return name === '/' || name === '/tmp' ? { uid:0,mode:entry.mode,isDirectory:()=>entry.isDirectory(),isSocket:()=>entry.isSocket() } : entry;
});

async function fixture(handler, fn) {
  const directory = await mkdtemp('/tmp/a6-viewer-socket-');
  await chmod(directory, 0o700);
  const socket = path.join(directory, 'viewer.sock');
  const server = createServer(handler);
  const previous = process.env.DATABASE_VIEWER_SOCKET_PATH;
  try {
    await new Promise(resolve => server.listen(socket, resolve));
    await chmod(socket, 0o600);
    process.env.DATABASE_VIEWER_SOCKET_PATH = socket;
    await fn(socket);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_VIEWER_SOCKET_PATH;
    else process.env.DATABASE_VIEWER_SOCKET_PATH = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('real private socket transport keeps path/query and strips credentials and Set-Cookie', async () => {
  await fixture((request, response) => {
    assert.equal(request.url, '/tables/jobs?limit=25');
    for (const name of ['cookie','authorization','x-user-id']) assert.equal(request.headers[name], undefined);
    response.writeHead(200, { 'content-type':'text/html', 'set-cookie':'authjs.session-token=hostile' });
    response.end('synthetic unchanged value 0.123456789123456789');
  }, async () => {
    const response = await fetchDatabaseViewerSocket('http://viewer.invalid/tables/jobs?limit=25', {
      headers: { cookie:'authjs.session-token=synthetic', authorization:'Bearer synthetic', 'x-user-id':'71' },
    });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), 'synthetic unchanged value 0.123456789123456789');
  });
});

test('public socket permissions, wrong owner/type and writable directory fail closed', async () => {
  const socket = { isSocket:()=>true, uid:1000, mode:0o600 };
  const directory = { isDirectory:()=>true, uid:0, mode:0o755 };
  assert.doesNotThrow(()=>verifySocketMetadata(socket,directory,1000));
  for (const [s,d] of [
    [{...socket,uid:1001},directory], [{...socket,mode:0o666},directory],
    [{...socket,isSocket:()=>false},directory], [socket,{...directory,mode:0o777}],
    [socket,{...directory,uid:1001}], [socket,{...directory,isDirectory:()=>false}],
  ]) assert.throws(()=>verifySocketMetadata(s,d,1000),/socket unavailable/);
  let calls=0;
  await fixture((_request,response)=>{calls++;response.end('unexpected');},async socketPath=>{
    await chmod(socketPath,0o666);
    await assert.rejects(fetchDatabaseViewerSocket('http://viewer.invalid/'),/socket unavailable/);
    assert.equal(calls,0);
  });
});

test('oversized responses, writes and interrupted reads are bounded', async () => {
  await fixture((_request,response)=>response.end(Buffer.alloc(1_048_577)),async()=>{
    await assert.rejects(fetchDatabaseViewerSocket('http://viewer.invalid/'),/limit exceeded/);
    await assert.rejects(fetchDatabaseViewerSocket('http://viewer.invalid/',{method:'POST'}),/method unavailable/);
  });
  await fixture(()=>{},async()=>{
    const controller=new AbortController();
    const pending=fetchDatabaseViewerSocket('http://viewer.invalid/',{signal:controller.signal});
    controller.abort();
    await assert.rejects(pending);
  });
});
