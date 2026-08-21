import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalStyles = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("dark mode replaces legacy light console surfaces", () => {
  for (const utility of [
    "bg-white",
    "bg-fuchsia-50",
    "bg-purple-100",
    "bg-amber-200",
    "bg-sky-200",
  ]) {
    assert.match(globalStyles, new RegExp(utility));
  }

  assert.match(
    globalStyles,
    /background-color: color-mix\(in oklch,[\s\S]+var\(--card\)\) !important;/,
  );
});

test("dark mode defines high-contrast semantic foregrounds", () => {
  for (const token of [
    "--dark-positive-foreground",
    "--dark-warning-foreground",
    "--dark-danger-foreground",
    "--dark-info-foreground",
    "--dark-accent-foreground",
  ]) {
    assert.match(globalStyles, new RegExp(token));
  }

  for (const family of ["emerald", "amber", "red", "blue", "violet"]) {
    assert.match(globalStyles, new RegExp(`text-${family}-`));
  }
});
