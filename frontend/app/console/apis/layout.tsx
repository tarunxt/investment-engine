import type { ReactNode } from 'react';

import LlmUsageBreakdown from './_components/LlmUsageBreakdown';

export default function ApisLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4">
      {children}
      <LlmUsageBreakdown />
    </div>
  );
}
