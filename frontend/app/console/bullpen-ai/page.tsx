import { BullpenAiPageShell } from "./_components/BullpenAiPageShell";

// Render on demand so protected Bullpen console requests cannot be served from a stale prerendered route artifact.
export const dynamic = "force-dynamic";

export default function BullpenAiPage() {
  return <BullpenAiPageShell />;
}
