'use client';

import { Label } from '@/components/ui/label';
import { Check } from 'lucide-react';
import { useDashboard } from '../_context';

function SelectSkeleton() {
  return <div className="h-8 w-full animate-pulse rounded-md border border-gray-200 bg-gray-100" />;
}

export function RunModeFields() {
  const {
    isLoading,
    providers,
    selectedTargets,
    totalAvailableTargets,
    toggleTarget,
    toggleAllForProvider,
    selectAllTargets,
    unselectAllTargets,
    savedModelMixes,
    selectedModelMixId,
    applyModelMix,
    saveModelMix,
    renameModelMix,
    deleteModelMix,
  } = useDashboard();

  const selectedCount = selectedTargets.size;
  const selectedEstimatedCostInr = providers.reduce((total, p) => {
    return (
      total +
      p.models.reduce((providerTotal, m) => {
        const key = `${p.name}::${m}`;
        if (!selectedTargets.has(key)) return providerTotal;
        const estimated = p.model_estimated_cost_inr?.[m];
        return providerTotal + (typeof estimated === 'number' ? estimated : 0);
      }, 0)
    );
  }, 0);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-gray-200 bg-gray-50 p-2">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
          <select
            value={selectedModelMixId || 'none'}
            onChange={(e) => applyModelMix(e.target.value)}
            className="h-8 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-700"
          >
            <option value="none">Model mix templates</option>
            {savedModelMixes.map((mix) => (
              <option key={mix.id} value={mix.id}>
                {mix.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="h-8 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-700 hover:bg-gray-100"
            onClick={() => {
              const name = window.prompt('Name this model mix:');
              if (!name) return;
              const id = saveModelMix(name);
              if (!id) window.alert('Select at least one model before saving a mix.');
            }}
          >
            Name and Save Model Mix
          </button>
          <button
            type="button"
            disabled={!selectedModelMixId}
            className="h-8 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-400"
            onClick={() => {
              if (!selectedModelMixId) return;
              const current = savedModelMixes.find((mix) => mix.id === selectedModelMixId);
              const name = window.prompt('Edit model mix name:', current?.name || '');
              if (!name) return;
              renameModelMix(selectedModelMixId, name);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={!selectedModelMixId}
            className="h-8 rounded-md border border-red-300 bg-white px-2 text-xs text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400"
            onClick={() => {
              if (!selectedModelMixId) return;
              const current = savedModelMixes.find((mix) => mix.id === selectedModelMixId);
              const ok = window.confirm(
                `Delete model mix "${current?.name || selectedModelMixId}"?`,
              );
              if (ok) deleteModelMix(selectedModelMixId);
            }}
          >
            Delete
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium text-gray-900">Models</Label>
        <div className="flex items-center gap-2">
          <div className="flex h-6 items-center rounded-full bg-indigo-50 px-2 text-xs font-medium text-indigo-700">
            {selectedCount} / {totalAvailableTargets}
          </div>
          <div className="flex h-6 items-center rounded-full bg-emerald-50 px-2 text-xs font-medium text-emerald-700">
            Est: ₹{selectedEstimatedCostInr.toFixed(2)}
          </div>
          <button
            type="button"
            onClick={selectAllTargets}
            disabled={totalAvailableTargets === 0 || selectedCount === totalAvailableTargets}
            className="text-xs text-indigo-600 hover:text-indigo-700 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={unselectAllTargets}
            disabled={selectedCount === 0}
            className="text-xs text-indigo-600 hover:text-indigo-700 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            Unselect all
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <SelectSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          {providers.map((p) => {
            const providerKeys = p.models.map((m) => `${p.name}::${m}`);
            const allChecked = providerKeys.every((k) => selectedTargets.has(k));
            const someChecked = providerKeys.some((k) => selectedTargets.has(k));

            return (
              <div key={p.name} className="border-b border-gray-100 last:border-b-0">
                {/* Provider header */}
                <div className="flex items-center justify-between px-3 py-2 hover:bg-gray-50">
                  <div className="flex items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={(el) => {
                          if (el) el.indeterminate = !allChecked && someChecked;
                        }}
                        onChange={() => toggleAllForProvider(p.name, p.models)}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-sm font-medium capitalize text-gray-900">
                        {p.name}
                      </span>
                    </label>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">
                      {providerKeys.filter(k => selectedTargets.has(k)).length} / {p.models.length}
                    </span>
                  </div>
                </div>

                {/* Models list */}
                <div className="border-t border-gray-100 bg-gray-50/50 px-3 py-2">
                  <div className="grid grid-cols-2 gap-1.5">
                    {p.models.map((m) => {
                      const key = `${p.name}::${m}`;
                      const isSelected = selectedTargets.has(key);
                      const estimatedInr = p.model_estimated_cost_inr?.[m];
                      const costLabel =
                        typeof estimatedInr === 'number' ? ` (₹${estimatedInr.toFixed(2)})` : '';
                      return (
                        <label
                          key={key}
                          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${isSelected
                            ? 'bg-indigo-50 text-indigo-700'
                            : 'hover:bg-gray-100'
                            }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleTarget(key)}
                            className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <span className="flex-1 truncate text-xs text-gray-700">
                            {m}{costLabel}
                          </span>
                          {isSelected && (
                            <Check className="h-3 w-3 text-indigo-600" />
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedCount === 0 && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm">
          <div className="h-4 w-4 rounded-full bg-red-400 text-center text-[10px] font-bold text-white">!</div>
          <p className="text-red-700">Select at least one model to continue</p>
        </div>
      )}
    </div>
  );
}
