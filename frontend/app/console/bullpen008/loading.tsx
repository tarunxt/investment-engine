export default function Bullpen008Loading() {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6" aria-label="Loading Bullpen 008">
      <div className="h-40 animate-pulse rounded-3xl bg-slate-100" />
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-64 animate-pulse rounded-3xl bg-slate-100" />)}
      </div>
    </div>
  );
}
