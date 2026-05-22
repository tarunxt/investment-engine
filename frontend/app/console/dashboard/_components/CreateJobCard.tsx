'use client';

import { CalendarClock, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboard } from '../_context';
import { RunModeFields } from './RunModeFields';
import { TemplateField } from './TemplateField';
import { PromptField } from './PromptField';
import { ScheduleField } from './ScheduleField';
import { GoogleSheetsField } from './GoogleSheetsField';

export function CreateJobCard() {
  const {
    prompt,
    scheduledAt,
    submitting,
    submitError,
    selectedTargets,
    charOverLimit,
    handleSubmit,
  } = useDashboard();

  return (
    <Card className="border border-gray-200 shadow-sm" size="sm">
      <CardHeader>
        <CardTitle>Create Job</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <RunModeFields />
          <TemplateField />
          <PromptField />
          <ScheduleField />
          <GoogleSheetsField />

          {submitError && <p className="text-sm text-red-700">{submitError}</p>}

          <Button
            type="submit"
            disabled={submitting || !prompt.trim() || charOverLimit || selectedTargets.size === 0}
            className="w-full"
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
              : `Run S1 (${selectedTargets.size} model${selectedTargets.size !== 1 ? 's' : ''})`}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
