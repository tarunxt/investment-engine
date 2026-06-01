'use client';

import { useState, type ReactNode } from 'react';
import { CalendarClock, ChevronDown, ChevronUp, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useDashboard } from '../_context';
import { RunModeFields } from './RunModeFields';
import { TemplateField } from './TemplateField';
import { PromptField } from './PromptField';
import { ScheduleField } from './ScheduleField';

export function CreateJobCard({
  promptAside,
  title = 'Create Job',
  collapsible = false,
  defaultExpanded = true,
  runActionLabel = 'Run S1',
  runButtonClassName,
}: {
  promptAside?: ReactNode;
  title?: string;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  runActionLabel?: string;
  runButtonClassName?: string;
} = {}) {
  const {
    prompt,
    scheduledAt,
    submitting,
    submitError,
    selectedTargets,
    charOverLimit,
    handleSubmit,
  } = useDashboard();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const showContent = !collapsible || isExpanded || Boolean(submitError);

  return (
    <Card className="border border-gray-200 shadow-sm" size="sm">
      <CardHeader className={cn(collapsible && 'pb-0')}>
        {collapsible ? (
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            aria-expanded={showContent}
            className="flex w-full items-center justify-between gap-4 text-left"
          >
            <CardTitle>{title}</CardTitle>
            <span className="rounded-full border border-gray-200 p-2 text-gray-500 transition hover:border-gray-300 hover:text-gray-700">
              {showContent ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </span>
          </button>
        ) : (
          <CardTitle>{title}</CardTitle>
        )}
      </CardHeader>
      {showContent ? (
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-5 xl:grid-cols-2">
            <div className="space-y-5">
              <RunModeFields />
            </div>
            <div className="space-y-5">
              <TemplateField />
              <PromptField aside={promptAside} />
              <ScheduleField />
            </div>

            {submitError && <p className="text-sm text-red-700 xl:col-span-2">{submitError}</p>}

            <Button
              type="submit"
              disabled={submitting || !prompt.trim() || charOverLimit || selectedTargets.size === 0}
              className={cn(
                'w-full xl:col-span-2',
                !scheduledAt && runButtonClassName,
              )}
            >
              {submitting ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : scheduledAt ? (
                <CalendarClock className="mr-2 size-4" />
              ) : (
                <Send className="mr-2 size-4" />
              )}
              {scheduledAt
                ? 'Schedule Job'
                : `${runActionLabel} (${selectedTargets.size} model${selectedTargets.size !== 1 ? 's' : ''})`}
            </Button>
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}
