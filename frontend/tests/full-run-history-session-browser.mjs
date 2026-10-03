// Browser lifecycle regression for the session guard. Run manually with:
// node tests/full-run-history-session-browser.mjs
// Uses only synthetic local data; no backend, credentials or external requests.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const frontend = fileURLToPath(new URL('../', import.meta.url));
const { webpack } = require('next/dist/compiled/webpack/webpack');
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const provider = await readFile(path.join(frontend, 'providers/AuthProvider.tsx'), 'utf8');
const serviceText = await readFile(path.join(frontend, 'services/api.ts'), 'utf8');
const ast = ts.createSourceFile('api.ts', serviceText, ts.ScriptTarget.Latest, true);
const service = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'apiServiceClass');
const names = new Set(['readDeduplicator', 'setSessionGeneration', 'getAllFullRuns']);
const serviceCode = compile(`export class HistoryService { ${service.members.filter((node) => names.has(node.name?.getText(ast))).map((node) => node.getText(ast)).join('\n')} }`);
const loaderCode = compile(await readFile(path.join(frontend, 'lib/fullRunHistory.ts'), 'utf8'));
const dedupeCode = compile(await readFile(path.join(frontend, 'lib/privateRequestDeduplicator.ts'), 'utf8'));
const correctedProviderCode = compile(provider);
const oldProviderCode = compile(provider.replace(/useLayoutEffect\(\(\) => \{\s*apiService\.setSessionGeneration/, 'useEffect(() => {\n    apiService.setSessionGeneration'));
const directory = await mkdtemp(path.join(tmpdir(), 'history-session-lifecycle-'));
let browser;
try {
  const entry = path.join(directory, 'fixture.cjs');
  await writeFile(entry, `
const React = require(${JSON.stringify(require.resolve('react'))});
const jsxRuntime = require(${JSON.stringify(require.resolve('react/jsx-runtime'))});
const { createRoot, hydrateRoot } = require(${JSON.stringify(require.resolve('react-dom/client'))});
const { renderToString } = require(${JSON.stringify(require.resolve('react-dom/server.browser'))});
function load(code, bindings = {}) {
  const loaded = { exports: {} };
  new Function('exports', 'module', ...Object.keys(bindings), code)(loaded.exports, loaded, ...Object.values(bindings));
  return loaded.exports;
}
const { PrivateRequestDeduplicator } = load(${JSON.stringify(dedupeCode)});
const { loadFullRunHistory } = load(${JSON.stringify(loaderCode)});
const URLs = { runs: { list: () => '/runs' } };
const { HistoryService } = load(${JSON.stringify(serviceCode)}, { PrivateRequestDeduplicator, loadFullRunHistory, URLs });
window.startFixture = ({ hydration, strict, legacy }) => {
  const events = [];
  const results = [];
  let account = 71;
  let childIndex = 0;
  const apiService = Object.assign(new HistoryService(), {
    getRuns: async () => {
      const id = account;
      events.push('summary:' + id);
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { items: [{ id }], pages: 1 };
    },
    getRun: async (id) => { events.push('detail:' + id); return { id }; },
  });
  const originalRegister = apiService.setSessionGeneration.bind(apiService);
  apiService.setSessionGeneration = (generation) => { events.push('register:' + generation); originalRegister(generation); };
  const SessionContext = React.createContext(null);
  const AuthContext = React.createContext(null);
  const initialUser = { id: 71, email: 'fixture@example.invalid', username: 'fixture' };
  const nextAuth = { useSession: () => ({ data: React.useContext(SessionContext), status: 'authenticated', update: async () => null }), signIn: async () => {}, signOut: async () => {} };
  const dependencies = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    'next-auth/react': nextAuth,
    '@/hooks/useAuth': { AuthContext },
    '@/services/cookies': { clearAuthCookies: () => {} },
    '@/services/api': { apiService, APIError: class extends Error {}, NetworkError: class extends Error {} },
    '@/lib/urls': { URLs },
    '@/lib/privateDashboardCache': { clearBrowserPrivateCacheOwner: () => {}, purgeBrowserPrivateDashboardCaches: () => {}, reconcileBrowserPrivateCacheOwner: () => {} },
  };
  const { AuthProvider } = load(legacy ? ${JSON.stringify(oldProviderCode)} : ${JSON.stringify(correctedProviderCode)}, {
    require: (name) => { if (!(name in dependencies)) throw new Error('Unexpected fixture dependency: ' + name); return dependencies[name]; },
    process: { env: { NODE_ENV: 'test' } },
  });
  function readHistory(label) {
    events.push('start:' + label);
    const request = apiService.getAllFullRuns();
    request.then((runs) => results.push({ label, ids: runs.map((run) => run.id) }), (error) => results.push({ label, error: error.message }));
    return request;
  }
  function Child() {
    React.useEffect(() => { void readHistory('child-' + (++childIndex)); }, []);
    return React.createElement('span', null, 'History fixture');
  }
  function App() {
    const [session, setSession] = React.useState({ generation: 'fixture-session-71', user: { id: '71' } });
    window.switchFixtureSession = (id, generation) => {
      account = id;
      setSession({ generation, user: { id: String(id) } });
    };
    return React.createElement(SessionContext.Provider, { value: session }, React.createElement(AuthProvider, { initialUser }, React.createElement(Child)));
  }
  const element = strict ? React.createElement(React.StrictMode, null, React.createElement(App)) : React.createElement(App);
  const container = document.getElementById('root');
  if (hydration) {
    container.innerHTML = renderToString(element);
    hydrateRoot(container, element);
  } else {
    createRoot(container).render(element);
  }
  window.fixture = { events, results, readHistory };
};
`);
  await new Promise((resolve, reject) => webpack({
    mode: 'none', target: 'web', entry,
    output: { path: directory, filename: 'bundle.js' },
    plugins: [new webpack.DefinePlugin({ 'process.env.NODE_ENV': JSON.stringify('test') })],
  }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox'] });
  for (const hydration of [false, true]) {
    for (const strict of [false, true]) {
      for (const legacy of [true, false]) {
        const page = await browser.newPage();
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ path: path.join(directory, 'bundle.js') });
        await page.evaluate((options) => window.startFixture(options), { hydration, strict, legacy });
        await page.waitForFunction(() => window.fixture?.results.length >= 1);
        await page.waitForTimeout(100);
        const initial = await page.evaluate(() => ({ events: window.fixture.events, results: window.fixture.results }));
        if (legacy) {
          assert.ok(initial.results.some((result) => /session changed/.test(result.error || '')), JSON.stringify(initial));
        } else {
          assert.ok(initial.results.every((result) => result.ids?.[0] === 71), JSON.stringify(initial));
          assert.ok(initial.events.indexOf('register:fixture-session-71') < initial.events.indexOf('start:child-1'), JSON.stringify(initial));
          // A new session object/refreshed expiry with the same generation may
          // rerender providers; it must not invalidate an active read.
          await page.evaluate(() => { void window.fixture.readHistory('same-session-refresh'); window.switchFixtureSession(71, 'fixture-session-71'); });
          await page.waitForFunction(() => window.fixture.results.some((result) => result.label === 'same-session-refresh'));
          const refresh = await page.evaluate(() => window.fixture.results.find((result) => result.label === 'same-session-refresh'));
          assert.deepEqual(refresh.ids, [71]);
          // Switch accounts while a summary is pending. The old flight rejects
          // before detail hydration, and the new account gets independent data.
          await page.evaluate(() => { void window.fixture.readHistory('before-switch'); window.switchFixtureSession(72, 'fixture-session-72'); });
          await page.waitForFunction(() => window.fixture.events.includes('register:fixture-session-72'));
          await page.evaluate(() => { void window.fixture.readHistory('after-switch'); });
          await page.waitForFunction(() => window.fixture.results.some((result) => result.label === 'after-switch'));
          const switched = await page.evaluate(() => window.fixture.results.filter((result) => result.label.includes('switch')));
          assert.match(switched.find((result) => result.label === 'before-switch').error, /session changed/);
          assert.deepEqual(switched.find((result) => result.label === 'after-switch').ids, [72]);
        }
        console.log(JSON.stringify({ hydration, strict, legacy, result: legacy ? 'reproduced original failure' : 'initial, refresh, and isolation passed', initialEvents: initial.events }));
        await page.close();
      }
    }
  }
} finally {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
