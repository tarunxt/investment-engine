import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import childProcess from 'node:child_process';

// Install egress/process guards before importing application code. VM imports
// below are allowlisted; its fetch is a synthetic-only transport boundary.
const deny = () => { throw new Error('Offline egress/process creation forbidden'); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
http.request = http.get = https.request = https.get = deny;
dns.lookup = dns.resolve = deny;
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[name] = deny;

const { performLogout, logoutRedirect, logoutWarning } = await import('../lib/logoutOutcome.ts');
const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

function providerLogout({ revoke, signOut, failCleanup = false, projectedUser = null, timers, apiClient } = {}) {
  const calls = [], errors = [];
  const source = read('../providers/AuthProvider.tsx');
  const callback = source.slice(source.indexOf('  const logout = useCallback('), source.indexOf('  const refreshAuth ='));
  const context = vm.createContext({
    useCallback: (fn) => fn, devAuthDisabled: false, devUser: {}, user: projectedUser,
    clearErrorState: () => calls.push('clear-error'),
    setStructuredError: (message) => errors.push(message),
    setLoading: (value) => calls.push(['loading', value]),
    setUser: (value) => calls.push(['user', value]),
    logoutRequestedRef: { current: false },
    logoutServerConfirmedRef: { current: false },
    logoutInFlightRef: { current: null },
    apiService: { beginLogout: () => { calls.push('begin-logout'); apiClient?.beginLogout(); },
      logout: async () => { calls.push('revoke'); return revoke?.(); },
      setSessionGeneration: (value) => calls.push(['generation', value]) },
    nextSignOut: async (options) => { calls.push(['sign-out', options.redirect]); return signOut?.(); },
    purgeBrowserPrivateDashboardCaches: () => { calls.push('purge-private'); if (typeof failCleanup === 'function' ? failCleanup() : failCleanup) throw new Error('synthetic storage failure'); },
    clearBrowserPrivateCacheOwner: () => calls.push('clear-owner'),
    clearAuthCookies: () => calls.push('clear-cookies'),
    performLogout: steps => performLogout({...steps, timers}), logoutRedirect, logoutWarning,
    window: { location: { href: 'unchanged' } },
  });
  vm.runInContext(stripTypeScriptTypes(callback.replace('const logout =', 'globalThis.logout ='), {mode:'transform'}), context);
  return { context, calls, errors, run: () => context.logout() };
}

test('actual provider requests revocation despite absent browser user projection and redirects only after acknowledgement', async () => {
  const fixture = providerLogout({ revoke: () => ({ session_revocation: 'confirmed' }) });
  await fixture.run();
  assert.equal(fixture.context.window.location.href, '/login');
  assert.equal(fixture.context.logoutRequestedRef.current, true);
  assert.ok(fixture.calls.indexOf('revoke') < fixture.calls.findIndex(c => Array.isArray(c) && c[0] === 'sign-out'));
  assert.ok(fixture.calls.includes('purge-private'));
  assert.equal(fixture.errors.length, 0);
});

for (const scenario of ['network','401','legacy','malformed','missing-ack']) {
  test(`actual provider preserves unconfirmed server status for ${scenario}`, async () => {
    const fixture = providerLogout({ revoke: () => {
      if (scenario === 'network' || scenario === '401') throw new Error('synthetic denied/lost reply');
      if (scenario === 'legacy') return { message: 'Logged out successfully' };
      if (scenario === 'malformed') return 'confirmed';
      return {};
    } });
    await fixture.run();
    assert.equal(fixture.context.window.location.href, '/login?logout=server-revocation-unconfirmed');
    assert.ok(fixture.errors[0].includes('could not be confirmed'));
    assert.ok(fixture.calls.includes('purge-private'));
    assert.ok(fixture.calls.includes('clear-owner'));
    assert.ok(fixture.calls.includes('clear-cookies'));
    assert.equal(fixture.calls.filter(c => c === 'revoke').length, 1);
  });
}

test('actual provider keeps local sign-out failure visible and still purges private cache', async () => {
  const fixture = providerLogout({ revoke: () => ({session_revocation:'confirmed'}), signOut: () => { throw new Error('synthetic SDK failure'); } });
  await fixture.run();
  assert.equal(fixture.context.window.location.href, 'unchanged');
  assert.ok(fixture.calls.includes('purge-private'));
  assert.ok(fixture.errors[0].includes('Retry sign-out'));
  assert.ok(fixture.errors[0].includes('server confirmed'));
});

test('actual provider attempts all cleanup after one storage failure without claiming completion', async () => {
  const fixture = providerLogout({ failCleanup: true });
  await fixture.run();
  assert.equal(fixture.context.window.location.href, 'unchanged');
  assert.ok(fixture.calls.includes('clear-owner'));
  assert.ok(fixture.calls.includes('clear-cookies'));
  assert.ok(fixture.errors[0].includes('could not be confirmed'));
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve=yes; reject=no; });
  return {promise,resolve,reject};
}
const flush = async () => { for(let i=0;i<12;i++)await Promise.resolve(); };
function fakeTimers() {
  let next=1;const pending=new Map();const delays=[];
  return {
    set: (callback, delay) => {const id=next++;pending.set(id,callback);delays.push(delay);return id;},
    clear: id => pending.delete(id),
    expire: () => {const callbacks=[...pending.values()];pending.clear();callbacks.forEach(fn=>fn());},
    pending,delays,
  };
}

test('non-settling revocation and SDK immediately hide private UI/purge cache and reach finite recovery', async () => {
  const timers=fakeTimers();const revoke=deferred(),sdk=deferred();
  const fixture=providerLogout({projectedUser:{id:'synthetic'},revoke:()=>revoke.promise,signOut:()=>sdk.promise,timers});
  const result=fixture.run();
  assert.ok(fixture.calls.some(call=>Array.isArray(call)&&call[0]==='user'&&call[1]===null));
  assert.ok(fixture.calls.includes('purge-private'));
  assert.ok(fixture.calls.indexOf('begin-logout')<fixture.calls.indexOf('purge-private'));
  await flush();
  assert.ok(fixture.calls.indexOf('purge-private')<fixture.calls.indexOf('revoke'));
  timers.expire();await flush();timers.expire();await result;
  assert.equal(fixture.context.window.location.href,'unchanged');
  assert.ok(fixture.errors.at(-1).includes('Retry sign-out'));
  assert.ok(fixture.errors.at(-1).includes('could not be confirmed'));
  assert.deepEqual(timers.delays,[5000,5000]);
  assert.equal(timers.pending.size,0);
  const errors=fixture.errors.length;
  revoke.resolve({session_revocation:'confirmed'});sdk.resolve({});await flush();
  assert.equal(fixture.errors.length,errors);
  assert.equal(fixture.context.window.location.href,'unchanged');
  assert.equal(fixture.context.logoutServerConfirmedRef.current,false);
});

test('confirmed server acknowledgement survives hanging SDK and explicit local retry without a second revocation', async () => {
  const timers=fakeTimers();const sdk=deferred();let sdkCalls=0;
  const fixture=providerLogout({revoke:()=>({session_revocation:'confirmed'}),signOut:()=>++sdkCalls===1?sdk.promise:Promise.resolve(),timers});
  const first=fixture.run();await flush();
  assert.equal(fixture.context.logoutServerConfirmedRef.current,true);
  timers.expire();await first;
  assert.ok(fixture.errors.at(-1).includes('server confirmed'));
  await fixture.run();
  assert.equal(fixture.calls.filter(call=>call==='revoke').length,1);
  assert.equal(fixture.context.window.location.href,'/login');
  assert.equal(fixture.context.logoutServerConfirmedRef.current,true);
  sdk.reject(new Error('synthetic late SDK rejection'));await flush();
  assert.equal(fixture.context.window.location.href,'/login');
});

test('simultaneous double logout shares one promise and cannot downgrade confirmed evidence', async () => {
  const firstAck=deferred(),secondAck=deferred(),local=deferred();let revokes=0;
  const fixture=providerLogout({revoke:()=>++revokes===1?firstAck.promise:secondAck.promise,signOut:()=>local.promise});
  const first=fixture.run(),second=fixture.run();
  await flush();
  firstAck.resolve({session_revocation:'confirmed'});await flush();
  secondAck.reject(new Error('synthetic concurrent backend 401'));
  // The rejected second response is never requested by the corrected path.
  secondAck.promise.catch(()=>{});
  local.resolve({});await Promise.all([first,second]);
  assert.equal(fixture.context.logoutServerConfirmedRef.current,true);
  assert.equal(fixture.context.window.location.href,'/login');
  assert.equal(revokes,1);
  assert.equal(first,second);
  assert.equal(fixture.calls.filter(call=>call==='purge-private').length,1);
  assert.equal(fixture.calls.filter(call=>Array.isArray(call)&&call[0]==='sign-out').length,1);
  const retry=fixture.run();
  assert.notEqual(retry,first);
  await retry;
  assert.equal(revokes,1);
  assert.equal(fixture.context.window.location.href,'/login');
});

test('cleanup retry retains durable confirmation and a fresh provider cannot inherit it', async () => {
  let storageFails=true;
  const fixture=providerLogout({revoke:async()=>({session_revocation:'confirmed'}),signOut:async()=>{},failCleanup:()=>storageFails});
  await fixture.run();
  assert.equal(fixture.context.logoutServerConfirmedRef.current,true);
  assert.equal(fixture.context.window.location.href,'unchanged');
  storageFails=false;await fixture.run();
  assert.equal(fixture.calls.filter(call=>call==='revoke').length,1);
  assert.equal(fixture.context.window.location.href,'/login');
  const fresh=providerLogout({revoke:async()=>{throw new Error('synthetic 401');},signOut:async()=>{}});
  await fresh.run();
  assert.equal(fresh.context.logoutServerConfirmedRef.current,false);
  assert.equal(fresh.context.window.location.href,'/login?logout=server-revocation-unconfirmed');
});

test('already confirmed evidence remains confirmed when a retry would receive backend 401', async () => {
  let requested=0;
  const outcome=await performLogout({previousServerRevocation:'confirmed',
    revoke:async()=>{requested++;throw new Error('synthetic 401');},signOut:async()=>{},cleanup:()=>{}});
  assert.equal(requested,0);
  assert.equal(outcome.serverRevocation,'confirmed');
  assert.equal(logoutRedirect(outcome),'/login');
});

function genericClient(fetchImpl, signOutImpl) {
  const source=read('../services/api.ts');
  const begin=source.slice(source.indexOf('  beginLogout() {'),source.indexOf('  setSessionGeneration('));
  const body=source.slice(source.indexOf('  async fetch<T>('),source.indexOf('  // HTTP methods'));
  class APIError extends Error {constructor(status,message){super(message);this.status=status;}}
  class NetworkError extends Error {}
  const location={href:'unchanged'};const sdkCalls=[];
  const context=vm.createContext({fetch:fetchImpl,signOut:async options=>{sdkCalls.push(options);return signOutImpl?.();},
    window:{location},APIError,NetworkError,InvalidAPIResponseError:class extends Error{},RequestTimeoutError:class extends Error{},
    DEFAULT_API_REQUEST_TIMEOUT_MS:20000,SLOW_API_REQUEST_THRESHOLD_MS:2000,devAuthDisabled:false,
    process:{env:{NODE_ENV:'test'}},console:{debug:()=>{}},performance,
    createCorrelationId:()=> 'synthetic-correlation',hasHeader:(headers,name)=>Object.keys(headers).some(k=>k.toLowerCase()===name.toLowerCase()),
    createRequestAbortContext:()=>({signal:new AbortController().signal,didTimeout:()=>false,cleanup:()=>{}}),
    deriveApiErrorMessage:(data,fallback)=>data.detail||fallback,
  });
  vm.runInContext(stripTypeScriptTypes(`class Api {logoutInProgress=false;readDeduplicator={setSessionGeneration:()=>{}};${begin}${body}};globalThis.api=new Api();`,{mode:'transform'}),context);
  for(const name of ['groupCollapsed','log','error','warn','groupEnd'])context.api[name]=()=>{};
  context.api.parseErrorResponse=async response=>response.json();
  return {api:context.api,location,sdkCalls};
}

test('outstanding generic 401 during logout cannot start SDK sign-out or erase unconfirmed warning', async () => {
  const response=deferred(),revoke=deferred();
  const client=genericClient(()=>response.promise);
  const pending=client.api.fetch('/synthetic/dashboard').catch(error=>error);
  const fixture=providerLogout({apiClient:client.api,revoke:()=>revoke.promise,signOut:async()=>{}});
  // Share the actual navigation sink across the two real call-path bodies.
  fixture.context.window.location=client.location;
  const logout=fixture.run();
  response.resolve(Response.json({detail:'synthetic 401'},{status:401}));await pending;
  assert.equal(client.sdkCalls.length,0);
  assert.equal(client.location.href,'unchanged');
  revoke.reject(new Error('synthetic backend failure'));await logout;
  assert.equal(client.location.href,'/login?logout=server-revocation-unconfirmed');
  assert.ok(fixture.errors.at(-1).includes('could not be confirmed'));
});

test('generic 401 cannot navigate over finite retry state when the dedicated SDK call never settles', async () => {
  const timers=fakeTimers(),response=deferred(),sdk=deferred();
  const client=genericClient(()=>response.promise);
  const pending=client.api.fetch('/synthetic/dashboard').catch(error=>error);
  const fixture=providerLogout({apiClient:client.api,revoke:async()=>{throw new Error('synthetic lost ack');},signOut:()=>sdk.promise,timers});
  fixture.context.window.location=client.location;
  const logout=fixture.run();await flush();
  response.resolve(Response.json({detail:'synthetic 401'},{status:401}));await pending;
  timers.expire();await logout;
  assert.equal(client.location.href,'unchanged');
  assert.ok(fixture.errors.at(-1).includes('Retry sign-out'));
  assert.ok(fixture.errors.at(-1).includes('could not be confirmed'));
  assert.equal(client.sdkCalls.length,0);
  sdk.resolve({});await flush();
  assert.equal(client.location.href,'unchanged');
});

test('generic SDK sign-out started before logout rechecks the fence before navigation', async () => {
  const sdk=deferred();
  const client=genericClient(async()=>Response.json({detail:'synthetic 401'},{status:401}),()=>sdk.promise);
  const pending=client.api.fetch('/synthetic/dashboard').catch(error=>error);await flush();
  assert.equal(client.sdkCalls.length,1);
  assert.equal(client.sdkCalls[0].redirect,false);
  const fixture=providerLogout({apiClient:client.api,revoke:async()=>{throw new Error('synthetic failure');},signOut:async()=>{}});
  fixture.context.window.location=client.location;
  await fixture.run();
  assert.equal(client.location.href,'/login?logout=server-revocation-unconfirmed');
  sdk.resolve({});await pending;
  assert.equal(client.location.href,'/login?logout=server-revocation-unconfirmed');
});

test('late generic private success and delayed body parsing cannot repopulate UI/cache after logout begins', async () => {
  for(const boundary of ['response','body']) {
    const late=deferred();
    const client=genericClient(()=>boundary==='response'?late.promise:Promise.resolve({ok:true,status:200,json:()=>late.promise}));
    let delivered=false;
    const pending=client.api.fetch('/synthetic/private').then(()=>{delivered=true;},error=>error);
    await flush();client.api.beginLogout();
    late.resolve(boundary==='response'?Response.json({private:'synthetic'}):{private:'synthetic'});
    await pending;
    assert.equal(delivered,false);
    assert.equal(client.sdkCalls.length,0);
  }
});

test('generic 401 outside logout retains ordinary navigation', async () => {
  const client=genericClient(async()=>Response.json({detail:'synthetic 401'},{status:401}));
  await client.api.fetch('/synthetic/dashboard').catch(error=>error);
  assert.equal(client.sdkCalls.length,1);
  assert.equal(client.location.href,'/login');
});

test('actual API logout opts out of generic automatic 401 sign-out', async () => {
  const source = read('../services/api.ts');
  const body = source.slice(source.indexOf('  logout(): Promise<LogoutResponse> {'), source.indexOf('  /**\n   * Get current user info', source.indexOf('  logout():')));
  const output = stripTypeScriptTypes(`class Api { ${body} }; globalThis.api = new Api();`, { mode:'transform' });
  const calls = [];
  const context = vm.createContext({ URLs: { auth: { logout: () => '/synthetic/logout' } } });
  vm.runInContext(output, context);
  context.api.post = (...args) => { calls.push(args); return Promise.resolve({}); };
  await context.api.logout();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].skipUnauthorizedRefresh, true);
});

test('login warning never treats URL text as server confirmation; console retains error and hides private children', () => {
  assert.equal(logoutWarning('confirmed'), null);
  assert.ok(logoutWarning('server-revocation-unconfirmed').includes('could not be confirmed'));
  const login = read('../app/(auth)/login/page.tsx');
  assert.match(login, /role="status"/);
  const shell = read('../app/console/_components/ConsoleShell.tsx');
  assert.match(shell, /!loading && !user && !error/);
  assert.match(shell, /\{user \? children : error \?/);
  assert.match(shell, /Retry sign-out/);
  const provider = read('../providers/AuthProvider.tsx');
  assert.match(provider, /if \(logoutRequestedRef.current\) return;/);
});

test('actual console redirect effect preserves unconfirmed logout warning', () => {
  const source = read('../app/console/_components/ConsoleShell.tsx');
  const start = source.indexOf('    useEffect(() => {\n        if (!loading && !user && !error)');
  const end = source.indexOf('    }, [error, loading, router, user]);', start) + '    }, [error, loading, router, user]);'.length;
  assert.ok(start >= 0);
  for (const error of ['Server session revocation could not be confirmed.', null]) {
    const redirects=[];
    const context=vm.createContext({useEffect:fn=>fn(),loading:false,user:null,error,
      router:{replace:path=>redirects.push(path)},URLs:{routes:{login:()=>'/login'}}});
    vm.runInContext(source.slice(start,end), context);
    assert.equal(redirects.length,error?0:1);
  }
});

test('actual delayed session hydration cannot restore user after logout starts', () => {
  const source=read('../providers/AuthProvider.tsx');
  const start=source.indexOf('  useEffect(() => {',source.indexOf('// The server-provided user'));
  const end=source.indexOf('  }, [session, status]);',start)+'  }, [session, status]);'.length;
  const users=[],timers=[];
  const ref={current:false};
  const context=vm.createContext({useEffect:fn=>fn(),devAuthDisabled:false,status:'authenticated',
    session:{userData:{id:'synthetic-user'}},logoutRequestedRef:ref,
    performance:{mark:()=>{},measure:()=>{}},
    window:{setTimeout:fn=>{timers.push(fn);return 1;},clearTimeout:()=>{}},
    setUser:value=>users.push(value),setLoading:()=>{}});
  const output=stripTypeScriptTypes(source.slice(start,end),{mode:'transform'});
  vm.runInContext(output,context);
  assert.equal(timers.length,1);
  ref.current=true;timers[0]();
  assert.deepEqual(users,[]);
  vm.runInContext(output,context);
  assert.equal(timers.length,1);
});

async function runtime(session, responseStatus = 200) {
  const paths = { session: '../app/api/bullpen-ai/_lib/serverBackendSession.ts', runtime: '../app/api/bullpen-ai/_lib/backendBullpenRuntime.ts', flight: '../lib/singleFlight.ts', transport: '../lib/boundedApiTransport.ts', cookies: '../lib/authSessionCookie.ts' };
  const aliases = { './backendBullpenRuntime':'runtime','@/lib/singleFlight':'flight','@/lib/boundedApiTransport':'transport','@/lib/authSessionCookie':'cookies' };
  const calls = [], updates = [];
  const context = vm.createContext({ Request, Response, Headers, AbortController, DOMException, URL, setTimeout, clearTimeout, console,
    process: {env:{BACKEND_API_URL:'http://backend.invalid'}},
    fetch: async (url, options) => {
      assert.equal(url, 'http://backend.invalid/dashboard/summary', 'SSR must not call refresh or any external target');
      assert.equal(options.method, 'GET');
      calls.push({url, options});
      return Response.json(responseStatus === 200 ? {synthetic:true} : {detail:'synthetic denied'}, {status:responseStatus});
    },
  });
  const modules = new Map();
  function synthetic(id, values) { const m = new vm.SyntheticModule(Object.keys(values), function(){ for(const [k,v] of Object.entries(values))this.setExport(k,v); }, {context,identifier:id}); modules.set(id,m); }
  synthetic('node:crypto',{createHash});
  synthetic('@auth/core/jwt',{getToken:async()=>session});
  synthetic('next/server',{NextResponse:Response});
  synthetic('@/auth',{resolveNextAuthSecret:()=> 'synthetic-unused',unstable_update:async(value)=>updates.push(value)});
  function load(id) { id=aliases[id]??id; if(modules.has(id))return modules.get(id); assert.ok(paths[id],`Forbidden import ${id}`); const m=new vm.SourceTextModule(stripTypeScriptTypes(read(paths[id]),{mode:'transform'}),{context,identifier:id});modules.set(id,m);return m; }
  const m=load('session'); await m.link((id)=>load(id)); await m.evaluate();
  return { api:m.namespace, backend:modules.get('runtime').namespace, calls, updates };
}

const session = (overrides={}) => ({sub:'42',accessToken:'synthetic-access',refreshToken:'synthetic-refresh',accessTokenExpiresAt:Date.now()+60000,...overrides});
for (const scenario of ['valid','expired','missing-access','backend-401','no-session']) {
  test(`actual SSR helpers and dashboard bootstrap perform no refresh or cookie writes: ${scenario}`, async () => {
    const token = scenario === 'no-session' ? null : session(scenario === 'expired' ? {accessTokenExpiresAt:0} : scenario === 'missing-access' ? {accessToken:null} : {});
    const fixture = await runtime(token, scenario === 'backend-401' ? 401 : 200);
    const ctx = await fixture.api.createBackendSessionContext({headers:new Headers()});
    assert.equal(ctx.refreshAllowed, false);
    await assert.rejects(fixture.api.rotateBackendTokens(ctx), e=>e.name==='BackendSessionHandlerRequiredError');
    await assert.rejects(fixture.api.fetchBackendJsonWithSession(ctx,'/dashboard/summary',{method:'POST',body:{}}), e=>e.name==='BackendSessionHandlerRequiredError');
    const source = read('../app/console/dashboard/page.tsx');
    const body = source.slice(source.indexOf('  let initialSummary:'),source.indexOf('\n  return ('));
    const output = stripTypeScriptTypes(`globalThis.bootstrap = async function(){${body}\nreturn initialSummary;}`,{mode:'transform'});
    const redirected = [];
    const context = vm.createContext({headers:async()=>new Headers(),console:{warn:()=>{}},
      createBackendSessionContext:fixture.api.createBackendSessionContext,
      fetchBackendJsonReadOnly:fixture.api.fetchBackendJsonReadOnly,
      BackendSessionHandlerRequiredError:fixture.api.BackendSessionHandlerRequiredError,
      BackendRuntimeHttpError:fixture.backend.BackendRuntimeHttpError,
      redirect:(path)=>{redirected.push(path);throw new Error('synthetic redirect');},
    });
    vm.runInContext(output, context);
    if(scenario==='no-session') {
      await assert.rejects(context.bootstrap(),/synthetic redirect/);
      assert.deepEqual(redirected,['/login?reason=session-expired']);
    } else {
      const result=await context.bootstrap();
      assert.equal(result?.synthetic??null, scenario==='valid'?true:null);
      assert.deepEqual(redirected,[]);
    }
    assert.equal(fixture.updates.length,0);
    assert.equal(fixture.calls.length,['valid','backend-401'].includes(scenario)?1:0);
    assert.ok(fixture.calls.every(call=>!call.url.includes('/auth/refresh')));
  });
}
