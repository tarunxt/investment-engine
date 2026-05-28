'use client';

import { Label } from '@/components/ui/label';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useDashboard } from '../_context';
import { Button } from '@/components/ui/button';
import { AnimatePresence, motion } from 'motion/react';

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
  } = useDashboard();

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set(providers.map(p => p.name)));

  const toggleProvider = (providerName: string) => {
    setExpandedProviders(prev => {
      const next = new Set(prev);
      if (next.has(providerName)) {
        next.delete(providerName);
      } else {
        next.add(providerName);
      }
      return next;
    });
  };

  const selectedCount = selectedTargets.size;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium text-gray-900">Models</Label>
        <div className="flex items-center gap-2">
          <div className="flex h-6 items-center rounded-full bg-indigo-50 px-2 text-xs font-medium text-indigo-700">
            {selectedCount} / {totalAvailableTargets}
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
            const isExpanded = expandedProviders.has(p.name);

            return (
              <div key={p.name} className="border-b border-gray-100 last:border-b-0">
                {/* Provider header */}
                <div className="flex items-center justify-between px-3 py-2 hover:bg-gray-50">
                  <div className="flex items-center gap-2">
                    <Button
                      variant={'ghost'}
                      onClick={() => toggleProvider(p.name)}
                      className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </Button>
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
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div className="border-t border-gray-100 bg-gray-50/50 px-3 py-2">
                      <div className="grid grid-cols-2 gap-1.5">
                        {p.models.map((m) => {
                          const key = `${p.name}::${m}`;
                          const isSelected = selectedTargets.has(key);
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
                              <span className="flex-1 text-xs text-gray-700 truncate">
                                {m}
                              </span>
                              {isSelected && (
                                <Check className="h-3 w-3 text-indigo-600" />
                              )}
                            </label>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
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
