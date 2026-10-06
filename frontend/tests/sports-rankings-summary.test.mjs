import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../app/console/sports-rankings/page.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

// Run the real page's hooks, handlers and JSX without a browser or network.
function mount(readRankingJson, search = '') {
  const states = [], effects = [], timers = new Map();
  let stateIndex, effectIndex, dirty = true, tree;
  const react = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => {
        const next = typeof value === 'function' ? value(states[index]) : value;
        if (!Object.is(next, states[index])) { states[index] = next; dirty = true; }
      }];
    },
    useMemo: callback => callback(),
    useCallback: callback => callback,
    useEffect(callback, dependencies) {
      const index = effectIndex++, previous = effects[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        effects[index] = { callback, dependencies, cleanup: previous?.cleanup, pending: true };
      }
    },
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '@/lib/sportsRankingsApi': { readRankingJson, RankingReadError: class extends Error {} },
  };
  const exports = {};
  new Function('exports', 'require', 'window', 'setTimeout', 'clearTimeout', 'fetch', compiled)(
    exports,
    name => { assert.ok(modules[name], `Unexpected module ${name}`); return modules[name]; },
    { location: { search } },
    (callback, ms) => { const id = Symbol('timer'); timers.set(id, { callback, ms }); return id; },
    id => timers.delete(id),
    () => assert.fail('Passive catalogue must not call an operational endpoint'),
  );
  return {
    get tree() { return tree; },
    timers,
    async settle() {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (dirty) {
          dirty = false; stateIndex = 0; effectIndex = 0;
          tree = exports.default();
          for (const effect of effects) {
            if (!effect.pending) continue;
            effect.pending = false;
            effect.cleanup?.();
            effect.cleanup = effect.callback();
          }
        }
        await new Promise(resolve => setImmediate(resolve));
        if (!dirty) return;
      }
      assert.fail('Page did not settle');
    },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
  };
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object') return text(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}
function input(page, label) {
  const result = nodes(page.tree, node => node.props.id === label || node.props['aria-label'] === label)[0];
  assert.ok(result, `Missing input ${label}`);
  return result;
}
function cards(page) {
  return nodes(page.tree, node => node.type === 'button' && 'aria-pressed' in node.props);
}
function competition(overrides = {}) {
  return {
    id: 'epl', code: 'epl', code_verified: true, name: 'Premier League',
    sport: 'Football', sport_id: 'football', category: 'Football', scope: 'England',
    entry_kind: 'imported_competition', reference_url: 'https://example.test/reference',
    source_id: 'football-feed', status: 'ready', ranking_kind: 'Standings',
    source_url: null, source_as_of: null, checked_at: null, successful_at: null,
    season: null, ranked_count: 20, note: 'Published league table', error: null,
    participants: Array.from({ length: 125 }, (_, i) => ({ name: `Participant ${i}`, aliases: [`Alias-${i}`] })),
    ...overrides,
  };
}
const catalogue = [
  competition(),
  competition({ id: 'cup/qualifier', code: 'cup', name: 'Cup Qualifier', source_id: null, status: 'unavailable', ranked_count: 0, participants: [{ name: 'Final Entrant', aliases: ['Last alias'] }] }),
  competition({ id: 'hockey', code: '', name: 'Hockey Championship', sport: 'Hockey', sport_id: 'hockey', source_id: 'hockey-feed', status: 'stale', ranked_count: 8, participants: [] }),
  competition({ id: 'reserve', name: 'Reserve League', participants: [] }),
];
function reader(calls) {
  return async (path, signal) => {
    calls.push({ path, signal });
    if (path === '?view=summary') return { competitions: catalogue };
    const card = catalogue.find(item => path === '/competitions/' + encodeURIComponent(item.id));
    assert.ok(card, `Unexpected read ${path}`);
    return {
      ...card,
      events: [{ title: `${card.name} full event`, slug: 'complete-event-slug' }],
      rows: [{ name: `${card.name} ranked participant`, rank: 1, points: 42, imported_names: ['Matched alias'] }],
    };
  };
}

test('summary cards preserve complete participant search, filters and existing counts', async t => {
  const calls = [], page = mount(reader(calls));
  t.after(() => page.unmount());
  await page.settle();
  assert.equal(calls[0].path, '?view=summary');
  assert.ok(catalogue.every(card => !('events' in card)));
  const header = nodes(page.tree, node => node.type === 'header')[0];
  assert.deepEqual(nodes(header, node => node.type === 'strong').map(text), ['2', '2', '4', '2', '1']);
  assert.deepEqual(cards(page).map(card => text(card.props.children[1])), ['Premier League', 'Reserve League', 'Hockey Championship', 'Cup Qualifier']);
  assert.match(text(cards(page)[0]), /20 published rows · 125 imported names/);

  for (const query of ['pArTiCiPaNt 124', 'ALIAS-124']) {
    input(page, 'competition-search').props.onChange({ target: { value: query } });
    await page.settle();
    assert.equal(cards(page).length, 1, query);
    assert.match(text(cards(page)[0]), /Premier League/);
    assert.match(text(page.tree), /1 ranking \/ competition lists/);
  }
  input(page, 'competition-search').props.onChange({ target: { value: '' } });
  input(page, 'Filter by ranking availability').props.onChange({ target: { value: 'Reference only' } });
  await page.settle();
  assert.equal(cards(page).length, 1);
  assert.match(text(cards(page)[0]), /Cup Qualifier/);
  input(page, 'Filter by ranking availability').props.onChange({ target: { value: 'Connected feeds' } });
  input(page, 'Filter by sport').props.onChange({ target: { value: 'Hockey' } });
  await page.settle();
  assert.equal(cards(page).length, 1);
  assert.match(text(cards(page)[0]), /Hockey Championship/);
});

test('summary navigation loads full encoded detail and renders its events and rows', async t => {
  const calls = [], page = mount(reader(calls));
  t.after(() => page.unmount());
  await page.settle();
  const oldDetail = calls.find(call => call.path === '/competitions/epl');
  assert.ok(oldDetail);
  cards(page).find(card => text(card).includes('Cup Qualifier')).props.onClick();
  await page.settle();
  assert.equal(oldDetail.signal.aborted, true);
  assert.equal(calls.at(-1).path, '/competitions/cup%2Fqualifier');
  assert.match(text(page.tree), /Cup Qualifier ranked participant/);
  assert.match(text(page.tree), /Imported events \(1\)/);
  assert.match(text(page.tree), /Cup Qualifier full event/);
  assert.ok(nodes(page.tree, node => node.props.href === 'https://polymarket.com/event/complete-event-slug').length);
});

test('competition deep links retain full-detail navigation after summary loading', async t => {
  const calls = [], page = mount(reader(calls), '?competition=cup%2Fqualifier&code=cup');
  t.after(() => page.unmount());
  await page.settle();
  assert.equal(calls[0].path, '?view=summary');
  assert.equal(calls.at(-1).path, '/competitions/cup%2Fqualifier');
  assert.equal(cards(page).length, 1);
  assert.equal(cards(page)[0].props['aria-pressed'], true);
  assert.match(text(page.tree), /Cup Qualifier full event/);
});

test('Retry now restarts the summary read and clears its failed request', async t => {
  const calls = [], read = reader(calls);
  let failedSignal;
  const page = mount(async (path, signal) => {
    if (!failedSignal) { failedSignal = signal; throw new Error('Temporary catalogue outage'); }
    return read(path, signal);
  });
  t.after(() => page.unmount());
  await page.settle();
  assert.match(text(page.tree), /Temporary catalogue outage/);
  const retry = nodes(page.tree, node => node.type === 'button' && text(node) === 'Retry now')[0];
  assert.ok(retry);
  retry.props.onClick();
  await page.settle();
  assert.equal(failedSignal.aborted, true);
  assert.equal(calls[0].path, '?view=summary');
  assert.equal(cards(page).length, 4);
  assert.equal(nodes(page.tree, node => node.props.role === 'alert').length, 0);
  assert.equal(page.timers.size, 1);
});

test('summary polling retains the minute interval and aborts reads on unmount', async () => {
  const calls = [], page = mount(reader(calls));
  try {
    await page.settle();
    assert.equal(page.timers.size, 1);
    const [id, timer] = [...page.timers][0];
    assert.equal(timer.ms, 60000);
    page.timers.delete(id);
    await timer.callback();
    await page.settle();
    assert.equal(calls.filter(call => call.path === '?view=summary').length, 2);
    assert.equal(page.timers.size, 1);
  } finally { page.unmount(); }
  assert.equal(page.timers.size, 0);
  assert.ok(calls.every(call => call.signal.aborted));
});
