// Execute current BFF + transport with synthetic auth/upstream doubles; no I/O.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
function load(relative, imports) {
  const code = ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend', relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`)(name => {
    assert.ok(name in imports, `unexpected dependency ${name}`); return imports[name];
  }, module, module.exports);
  return module.exports;
}
test('jobs BFF forwards actor, preserves owner denial and does not share responses', async () => {
  const originalFetch = global.fetch;
  const env = { ...process.env };
  process.env.BACKEND_API_URL = 'http://synthetic.invalid';
  process.env.NEXT_PUBLIC_DISABLE_AUTH = 'false';
  const calls = [];
  class NextResponse extends Response { static json(body, init) { return Response.json(body, init); } }
  const route = load('app/backend-api/[...path]/route.ts', {
    'next/server': { NextResponse },
    '@/lib/boundedApiTransport': load('lib/boundedApiTransport.ts', {}),
    '@/app/api/bullpen-ai/_lib/serverBackendSession': {
      createBackendSessionContext: async req => req.headers.get('x-fixture-actor')
        ? { accessToken: req.headers.get('x-fixture-actor') } : null,
      rotateBackendTokens: async () => false,
    },
    '@/app/api/bullpen-ai/_lib/backendBullpenRuntime': { BackendRuntimeHttpError: class extends Error {} },
  });
  global.fetch = async (url, options) => {
    const actor = options.headers.get('authorization');
    calls.push({ actor, url: String(url), cache: options.cache });
    assert.ok(['Bearer actorA', 'Bearer actorB'].includes(actor));
    if (new URL(url).pathname === '/jobs/41' && actor === 'Bearer actorA')
      return Response.json({ id: 41, response: 'synthetic A output' });
    if (new URL(url).pathname === '/jobs')
      return Response.json({ items: actor === 'Bearer actorA' ? [{ id: 41 }] : [], total: actor === 'Bearer actorA' ? 1 : 0 });
    return Response.json({ detail: 'Job not found' }, { status: 404 });
  };
  async function get(path, actor) {
    const req = new Request(`http://localhost/backend-api/${path}`, {
      headers: { ...(actor ? { 'x-fixture-actor': actor } : {}), authorization: 'Bearer spoofed-actorA' },
    });
    req.nextUrl = new URL(req.url);
    return route.GET(req, { params: Promise.resolve({ path: path.split('/') }) });
  }
  try {
    assert.equal((await get('jobs/41', 'actorA')).status, 200);
    const denied = await get('jobs/41', 'actorB'), missing = await get('jobs/999', 'actorB');
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), await missing.json());
    assert.deepEqual((await (await get('jobs', 'actorB')).json()).items, []);
    assert.equal((await (await get('jobs', 'actorA')).json()).total, 1);
    const before = calls.length;
    assert.equal((await get('jobs/41', null)).status, 401);
    assert.equal((await get('jobs', null)).status, 401);
    assert.equal(calls.length, before);
    assert.ok(calls.every(c => c.cache === 'no-store'));
  } finally {
    global.fetch = originalFetch;
    for (const key of ['BACKEND_API_URL', 'NEXT_PUBLIC_DISABLE_AUTH'])
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
});
