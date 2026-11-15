import type { ReactNode } from "react";

import { Bullpen008MetricTileDrilldownEnhancer } from "./_components/Bullpen008MetricTileDrilldownEnhancer";
import { Bullpen008StageDialogCollapseEnhancer } from "./_components/Bullpen008StageDialogCollapseEnhancer";

export default function Bullpen008Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <Bullpen008StageDialogCollapseEnhancer />
      <Bullpen008MetricTileDrilldownEnhancer />
      {children}
    </>
  );
}
