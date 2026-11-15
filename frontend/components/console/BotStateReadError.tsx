/** Recovery for a failed state read only; never retries operational APIs. */
export function BotStateReadError({
  pageName,
  error,
  retained = false,
}: {
  pageName: string;
  error: string | null;
  retained?: boolean;
}) {
  const Heading = retained ? "h2" : "h1";
  return (
    <section
      aria-label={`${pageName} state unavailable`}
      className="min-w-0 rounded-[24px] border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-900"
    >
      <div role="status">
        <Heading className="text-lg font-semibold">{pageName}: state unavailable</Heading>
        <p className="mt-2 leading-6">
          The bot state read failed. This page’s data could not be checked.
        </p>
        {retained ? (
          <p className="mt-2 leading-6">
            Previously loaded data remains below. It may be out of date; current
            balances, positions and execution status could not be verified.
          </p>
        ) : (
          <p className="mt-2 leading-6">
            Current balances, positions and execution status are unknown.
          </p>
        )}
      </div>
      <a
        href="/console"
        className="mt-4 inline-flex min-h-11 items-center rounded-md border border-rose-300 bg-white px-4 font-medium text-slate-950 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-950"
      >
        Back to console
      </a>
      {error ? (
        <details className="mt-4 [overflow-wrap:anywhere]">
          <summary className="cursor-pointer rounded py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950">Read error details</summary>
          <p className="mt-2 whitespace-pre-wrap">{error}</p>
        </details>
      ) : null}
    </section>
  );
}
