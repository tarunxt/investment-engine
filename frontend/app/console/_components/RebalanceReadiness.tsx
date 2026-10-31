import { inputReadiness } from "@/lib/rebalanceReadiness";

type Props = {
  loading: boolean;
  error: string | null;
  portfolio: { holdings: unknown[] } | null;
  threats: { status: string; report?: { raw_markdown?: string | null } | null } | null;
  selectedSwingCount: number;
  blockedReason: string | null;
};

export function RebalanceReadiness({ loading, error, portfolio, threats, selectedSwingCount, blockedReason }: Props) {
  const rows = [
    { name: "Portfolio", state: inputReadiness(loading, error, Boolean(portfolio?.holdings.length)), detail: "Latest holdings snapshot" },
    { name: "Swing", state: inputReadiness(loading, error, selectedSwingCount > 0), detail: `${selectedSwingCount} selected model outputs after the previous market close` },
    { name: "Threats", state: inputReadiness(loading, error, Boolean(threats?.report?.raw_markdown?.trim()), threats?.status), detail: threats && !threats.report?.raw_markdown ? "Latest report has no parsed markdown output yet" : "Latest risk report" },
  ];
  return (
    <section aria-label="Rebalance readiness" className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
      <h2 className="font-semibold text-gray-950">Rebalance readiness</h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-3">
        {rows.map(({ name, state, detail }) => (
          <li key={name} className="rounded-lg border border-gray-200 p-3">
            <div className="flex items-center justify-between gap-2"><strong>{name}</strong><span className={state === "Ready" ? "text-emerald-700" : state === "Failed" ? "text-red-700" : "text-amber-700"}>{state}</span></div>
            <p className="mt-1 text-xs text-gray-600">{loading ? "Loading saved inputs…" : error ? "Saved inputs could not be loaded. Refresh Input Box to retry." : detail}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 font-medium" role="status">{blockedReason ? `Execution blocked: ${blockedReason}` : "Execution may proceed under the current input rules."}</p>
      <p className="mt-1 text-xs text-gray-600">Swing and Threats context is not required by the existing input rules. Checklist states describe saved context; the execution message reflects submission checks. US holdings must pass the existing snapshot validation. Model selection and prompt checks still apply; queued jobs remain subject to server validation.</p>
      <p className="mt-1 text-xs text-gray-600">An unknown model estimate is not a verified zero and does not change execution eligibility. A reported ₹0.00 estimate does not confirm a free run.</p>
    </section>
  );
}
