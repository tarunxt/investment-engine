import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("stock details historical suggestions match stock identifiers, not a shared exchange", () => {
  const source = readFileSync(
    new URL(
      "../app/console/_components/FinalActionablesConsole.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  const aliases = source.match(
    /function getStockMatchAliases\(stock: StockConsensus\) \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(aliases, "expected the historical stock identity matcher");
  assert.match(
    source,
    /effectiveHistoricalRows\.filter\(\(row\) => stockConsensusMatches\(row\.stock, stock\)\)/,
  );
  assert.doesNotMatch(aliases, /stock\.exchange/);
  assert.doesNotMatch(aliases, /\["Exchange Symbol"\]/);
});
