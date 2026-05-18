'use client';

import { Label } from '@/components/ui/label';
import { useDashboard } from '../_context';

function SelectSkeleton() {
  return <div className="h-9 w-full animate-pulse rounded border border-gray-200 bg-gray-100" />;
}

export function RunModeFields() {
  const {
    isLoading,
    providers,
    selectedTargets,
    totalAvailableTargets,
    toggleTarget,
    toggleAllForProvider,
  } = useDashboard();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Models</Label>
        <span className="text-xs text-gray-500">
          {selectedTargets.size} / {totalAvailableTargets} selected
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <SelectSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded border border-gray-200">
          {providers.map((p) => {
            const providerKeys = p.models.map((m) => `${p.name}::${m}`);
            const allChecked = providerKeys.every((k) => selectedTargets.has(k));
            const someChecked = providerKeys.some((k) => selectedTargets.has(k));
            return (
              <div key={p.name} className="px-3 py-2">
                <label className="flex cursor-pointer items-center gap-2 pb-1.5">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = !allChecked && someChecked;
                    }}
                    onChange={() => toggleAllForProvider(p.name, p.models)}
                    className="size-3.5 accent-indigo-600"
                  />
                  <span className="text-xs font-semibold capitalize text-gray-700">{p.name}</span>
                </label>
                <div className="ml-5 space-y-1">
                  {p.models.map((m) => {
                    const key = `${p.name}::${m}`;
                    return (
                      <label key={key} className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedTargets.has(key)}
                          onChange={() => toggleTarget(key)}
                          className="size-3.5 accent-indigo-600"
                        />
                        <span className="text-xs text-gray-600">{m}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedTargets.size === 0 && (
        <p className="text-xs text-red-600">Select at least one model.</p>
      )}
    </div>
  );
}
