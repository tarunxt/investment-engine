import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../app/console/_components/FinalActionablesConsole.tsx", import.meta.url),
  "utf8",
);

test("final actionables consensus denominator uses only LLMs with parsed output", () => {
  assert.match(
    source,
    /const parsedRows = runs\s*\.flatMap\(parseRunRows\)\s*\.filter\(\(row\) => Object\.values\(row\.cells\)\.some\(\(value\) => value\.trim\(\)\)\);/,
  );
  assert.match(
    source,
    /const outputMetaKeys = new Set\(parsedRows\.map\(\(row\) => getMetaKey\(row\.meta\)\)\);/,
  );
  assert.match(
    source,
    /const totalSuggestions = consensusDenominator \|\| rows\.length;/,
  );
  assert.doesNotMatch(source, /const totalSuggestions = llmMetas\.length \|\| rows\.length;/);
});

test("consensus breakup omits LLMs without usable output from denominator entries", () => {
  assert.match(
    source,
    /const outputLlmMetas = llmMetas\.filter\(\(meta\) => outputMetaKeys\.has\(getMetaKey\(meta\)\)\);/,
  );
  assert.match(
    source,
    /const breakupEntries = \(outputLlmMetas\.length \? outputLlmMetas : rows\.map\(\(row\) => row\.meta\)\)/,
  );
  assert.match(source, /Recommendation denominator includes only LLMs with completed or partial output/);
});
