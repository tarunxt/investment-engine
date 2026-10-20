"use client";

import {SafetyActivity} from "@/components/modules/SafetyActivity";
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
      
      <SafetyActivity />
    </div>
  );
}
