'use client';

import { CalendarClock } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useDashboard } from '../_context';

export function ScheduleField() {
  const { scheduledAt, setScheduledAt } = useDashboard();

  return (
    <div className="space-y-2">
      <Label htmlFor="scheduled-at" className="flex items-center gap-1.5">
        <CalendarClock className="size-3.5 text-gray-400" />
        Schedule (optional)
      </Label>
      <input
        id="scheduled-at"
        type="datetime-local"
        value={scheduledAt}
        onChange={(e) => setScheduledAt(e.target.value)}
        min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
        className="w-full border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-950 outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950/10"
      />
      {scheduledAt && (
        <p className="text-xs text-violet-600">
          Job will run at {new Date(scheduledAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
