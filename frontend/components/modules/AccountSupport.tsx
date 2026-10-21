import Link from 'next/link';
export function AccountSupport(){
 return <section aria-labelledby="account-support-heading" className="space-y-3 rounded-xl border p-5 min-w-0">
  <h2 id="account-support-heading" className="font-semibold">Your CredX account</h2>
  <p>You can start with every optional module off. Enable only the products you need in <Link className="underline" href="/console/profile/preferences">Preferences</Link>. Enabling a module does not approve an order, authorize a provider or liquidate a position.</p>
  <p>For an expired session, sign in again using the same account, then reopen <Link className="underline" href="/console/profile/activity">Safety activity</Link> and refresh recorded status. Never repeat a financial instruction because a browser request timed out.</p>
  <p><Link className="underline" href="/console/profile/connections">Connections</Link> shows masked account bindings and provider readiness. Use your own supported app or a separately approved managed app. Do not paste provider secrets into help requests. A disconnected or expired connection requires its supported authorization flow; reconnecting is not order consent.</p>
  <p>Personal usage and limits remain account-scoped in <Link className="underline" href="/console/apis">Usage</Link>. Administrative infrastructure costs require their existing role; usage limits do not grant order consent.</p>
  <p>Disabling a module, disconnecting an account, canceling an order and closing a position are different actions. This safety screen offers no financial cancel or close action and never automatically liquidates.</p>
 </section>;
}
