import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("queued Stage 3 does not show saved preview counts while an active run is still in Stage 2", () => {
  const source = readFileSync(
    new URL("../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /stage\.state === "queued" &&\s*workflowView\.runStatus !== "running" &&\s*Array\.isArray\(stage\.inputs\.llm_review_rows\)/);
});
