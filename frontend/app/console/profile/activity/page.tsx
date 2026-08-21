"use client";

import { Separator } from "@/components/ui/separator";

export default function ActivityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Activity</h3>
        <p className="text-sm text-muted-foreground">
          View your recent account activity.
        </p>
      </div>
      <Separator />
      
      <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground space-y-4 border rounded-md border-dashed">
        <p>Activity logs are not available at this moment.</p>
      </div>
    </div>
  );
}
