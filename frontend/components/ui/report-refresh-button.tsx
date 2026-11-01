import type { ComponentProps } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Shared report-toolbar action; callers retain their own request and disabled state.
export function ReportRefreshButton({ loading, ...props }: Omit<ComponentProps<typeof Button>, 'children' | 'variant' | 'size'> & { loading: boolean }) {
  return (
    <Button variant="outline" size="sm" {...props}>
      <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
      Refresh
    </Button>
  );
}
