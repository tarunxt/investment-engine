import type { ReactNode } from "react";
import { CostUsageProvider } from "./CostUsageProvider";

export default function CostDriversLayout({ children }: { children: ReactNode }) {
  return (
    <CostUsageProvider>
      {children}
    </CostUsageProvider>
  );
}
