"use client";

import {AccountSupport} from "@/components/modules/AccountSupport";
import {RecordedPositions} from "@/components/modules/RecordedPositions";
import {OrderReviews} from "@/components/modules/OrderReviews";
import {SafetyActivity} from "@/components/modules/SafetyActivity";
import { Separator } from "@/components/ui/separator";

export default function ActivityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Activity</h3>
        <p className="text-sm text-muted-foreground">
          Review recorded orders and safety activity, including when a module is disabled.
        </p>
      </div>
      <Separator />
      
      <OrderReviews />
      <RecordedPositions />
      <SafetyActivity />
      <AccountSupport />
    </div>
  );
}
