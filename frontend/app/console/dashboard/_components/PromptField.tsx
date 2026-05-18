'use client';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useDashboard, PROMPT_MAX_CHARS } from '../_context';

export function PromptField() {
  const { prompt, promptRef, charCount, charOverLimit, charNearLimit, handlePromptChange } =
    useDashboard();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="prompt">Prompt</Label>
        <span
          className={cn(
            'text-xs tabular-nums',
            charOverLimit
              ? 'font-semibold text-red-600'
              : charNearLimit
                ? 'text-amber-600'
                : 'text-gray-400',
          )}
        >
          {charCount}/{PROMPT_MAX_CHARS}
        </span>
      </div>
      <textarea
        id="prompt"
        ref={promptRef}
        value={prompt}
        onChange={handlePromptChange}
        rows={9}
        className={cn(
          'w-full resize-none border bg-white px-3 py-2 text-sm text-gray-950 shadow-sm outline-none transition focus:ring-2 focus:ring-gray-950/10',
          charOverLimit
            ? 'border-red-400 focus:border-red-500'
            : 'border-gray-300 focus:border-gray-950',
        )}
        placeholder="Analyze Apple earnings quality, valuation risk, and near-term catalysts."
      />
    </div>
  );
}
