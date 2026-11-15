import { readBullpenScheduleSource } from "./helpers/bullpenScheduleSource.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("queued Stage 3 does not show saved preview counts while an active run is still in Stage 2", () => {
  const source = readBullpenScheduleSource();

  assert.match(source, /stage\.state === "queued" &&\s*workflowView\.runStatus !== "running" &&\s*Array\.isArray\(stage\.inputs\.llm_review_rows\)/);
});
