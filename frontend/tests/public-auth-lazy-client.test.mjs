import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';

function harness(file, options = {}) {
  const state = [], callbacks = [], redirects = [], signIns = [], fetches = [];
  let loads = 0;
  const react = {
    useState(initial) { const slot = state.length; state.push(initial); return [initial, value => { state[slot] = value; }]; },
    useCallback(fn) { callbacks.push(fn); return fn; }, useMemo: fn => fn(),
    useRef: value => ({ current: value }), useEffect() {},
  };
  const imports = {
    react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@/hooks/useAuth': { AuthContext: { Provider: 'context' } },
    '@/lib/authRedirect': { resolveAuthRedirectTarget: value => value },
  };
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('require', 'exports', 'window', 'fetch', code)(name => {
    if (name === 'next-auth/react') {
      loads++;
      if (options.loadError) throw new Error('synthetic chunk failure');
      return { signIn: async (...args) => { signIns.push(args); return options.signIn ? options.signIn(...args) : { ok: true, url: '/console/dashboard' }; } };
    }
    assert.ok(name in imports, name); return imports[name];
  }, exports, { location: { assign: value => redirects.push(value) } }, async (...args) => {
    fetches.push(args); return { ok: true };
  });
  return { exports, state, callbacks, redirects, signIns, fetches, loads: () => loads };
}

test('password sign-in loads Auth.js only on action and preserves credential options', async () => {
  const h = harness('../providers/PublicAuthProvider.tsx');
  const auth = h.exports.PublicAuthProvider({ children: null }).props.value;
  assert.equal(h.loads(), 0);
  await auth.login('synthetic@example.invalid', 'synthetic-password', '/console/profile');
  assert.equal(h.loads(), 1);
  assert.deepEqual(h.signIns, [['credentials', { email: 'synthetic@example.invalid', password: 'synthetic-password', callbackUrl: '/console/profile', redirect: false }]]);
  assert.deepEqual(h.redirects, ['/console/dashboard']);
  assert.equal(h.state[0], false);
});
test('username and rejected credentials retain behavior and never redirect on failure', async () => {
  const h = harness('../providers/PublicAuthProvider.tsx', { signIn: async () => ({ error: 'CredentialsSignin' }) });
  const auth = h.exports.PublicAuthProvider({ children: null }).props.value;
  await assert.rejects(auth.login('synthetic-user', 'synthetic-password'), /CredentialsSignin/);
  assert.equal(h.signIns[0][1].username, 'synthetic-user');
  assert.equal(h.state[1], 'Invalid email, username, or password.');
  assert.equal(h.state[0], false);
  assert.deepEqual(h.redirects, []);
});
test('password lazy-load failure clears loading and reports an error without authentication', async () => {
  const h = harness('../providers/PublicAuthProvider.tsx', { loadError: true });
  const auth = h.exports.PublicAuthProvider({ children: null }).props.value;
  await assert.rejects(auth.login('synthetic-user', 'synthetic-password'), /synthetic chunk failure/);
  assert.equal(h.state[0], false);
  assert.equal(h.state[1], 'synthetic chunk failure');
  assert.deepEqual(h.signIns, []);
  assert.deepEqual(h.redirects, []);
});
test('registration still uses the backend and Auth.js automatic login', async () => {
  const h = harness('../providers/PublicAuthProvider.tsx');
  const auth = h.exports.PublicAuthProvider({ children: null }).props.value;
  await auth.register('synthetic@example.invalid', 'synthetic-user', 'synthetic-password');
  assert.equal(h.fetches[0][0], '/backend-api/auth/register');
  assert.equal(h.fetches[0][1].method, 'POST');
  assert.equal(h.signIns[0][0], 'credentials');
});
test('Google sign-in loads Auth.js only after a credential and preserves duplicate fence', async () => {
  let resolve;
  const h = harness('../components/auth/GoogleSignIn.tsx', { signIn: () => new Promise(r => { resolve = r; }) });
  h.exports.GoogleSignIn({ redirectTo: '/console/profile' });
  assert.equal(h.loads(), 0);
  const complete = h.callbacks[0];
  const first = complete({ credential: 'synthetic-google-credential' });
  await new Promise(setImmediate);
  await complete({ credential: 'duplicate' });
  assert.deepEqual(h.signIns, [['google', { credential: 'synthetic-google-credential', redirect: false }]]);
  resolve({ ok: true }); await first;
  assert.deepEqual(h.redirects, ['/console/profile']);
  assert.equal(h.state[2], false);
});
test('Google lazy-load failure is recoverable and never authenticates or redirects', async () => {
  const h = harness('../components/auth/GoogleSignIn.tsx', { loadError: true });
  h.exports.GoogleSignIn({ redirectTo: '/console/profile' });
  await h.callbacks[0]({ credential: 'synthetic-google-credential' });
  await h.callbacks[0]({ credential: 'retry-synthetic-credential' });
  assert.equal(h.loads(), 2);
  assert.equal(h.state[2], false);
  assert.match(h.state[3], /could not be completed/);
  assert.deepEqual(h.signIns, []);
  assert.deepEqual(h.redirects, []);
});
test('static 404 retains navigation without a client UI boundary', () => {
  const source = readFileSync(new URL('../app/not-found.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /["']use client["']/);
  assert.doesNotMatch(source, /from ["']@\/components\/ui\/button["']/);
  assert.match(source, /from ["']@\/components\/ui\/buttonVariants["']/);
  assert.match(source, /<Link href="\/"/);
  assert.match(source, /<Link href="\/login"/);
  assert.doesNotMatch(source, /<Button/);
});
test('isolated button style module preserves every existing variant', () => {
  const source = readFileSync(new URL('../components/ui/buttonVariants.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /radix-ui|use client/);
  const definition = source.slice(source.indexOf('const buttonVariants = cva('), source.indexOf('\n\nexport {')).trim();
  assert.equal(createHash('sha256').update(definition).digest('hex'),
    'd8672c395b3b44dc102af19adda522c557b61e3cffab151192337aa613397c6b');
  const button = readFileSync(new URL('../components/ui/button.tsx', import.meta.url), 'utf8');
  assert.match(button, /import \{ buttonVariants \} from "\.\/buttonVariants"/);
  assert.match(button, /export \{ Button, buttonVariants \}/);
});
