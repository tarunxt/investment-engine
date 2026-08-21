import type { ReactNode } from "react";
import { OptimizationActionCenter } from "./OptimizationActionCenter";

export default function CostDriversLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      <OptimizationActionCenter />
      {children}
    </div>
  );
}
