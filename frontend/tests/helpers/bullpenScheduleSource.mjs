import { readFileSync } from 'node:fs';

/** Existing formula/presentation characterizations now span extracted modules.
 * Loading boundaries are checked separately against the actual individual files.
 */
export function readBullpenScheduleSource() {
  const base = new URL('../../app/console/bullpen-ai/_components/', import.meta.url);
  return ['bullpenScheduleShared.tsx', 'BullpenScheduleDetails.tsx', 'BullpenAutoRunScheduleCard.tsx']
    .map(name => readFileSync(new URL(name, base), 'utf8')).join('\n');
}
