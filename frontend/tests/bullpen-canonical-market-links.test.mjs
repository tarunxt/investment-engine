import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const trendsTable = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenEventTrendsTable.tsx",
    import.meta.url,
  ),
  "utf8",
);
const marketLinks = readFileSync(
  new URL("../lib/bullpenMarketLinks.ts", import.meta.url),
  "utf8",
);
const marketLinkRoute = readFileSync(
  new URL("../app/api/bullpen-ai/market-link/route.ts", import.meta.url),
  "utf8",
);

test("Bullpen History event names use the canonical-link resolver", async () => {
  assert.match(
    trendsTable,
    /import \{ buildBullpenMarketUrl \} from "@\/lib\/bullpenMarketLinks"/,
  );
  assert.match(
    trendsTable,
    /href=\{buildBullpenMarketUrl\(event\.market_id\)\}/,
  );
  assert.match(marketLinks, /BULLPEN_LINK_RESOLVER_PATH = "\/api\/bullpen-ai\/market-link"/);
  const executable = ts.transpileModule(marketLinks, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const links = await import(`data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`);
  assert.equal(links.buildBullpenMarketUrl(" market-1 "), "/api/bullpen-ai/market-link?marketId=market-1");
  const canonical = new URL(links.buildBullpenCanonicalMarketUrl({ marketId: "market-1", eventSlug: "event one", marketSlug: "market one", outcome: "No" }));
  assert.equal(canonical.pathname, "/predictions/polymarket/event/event%20one");
  assert.equal(canonical.searchParams.get("marketSlug"), "market one");
  assert.equal(canonical.searchParams.get("outcome"), "No");
  assert.equal(canonical.searchParams.get("marketId"), "market-1");
  assert.throws(() => links.buildBullpenMarketUrl(" "), /marketId is required/);
});

test("canonical Bullpen links use Polymarket event and market slugs", () => {
  assert.match(
    marketLinks,
    /https:\/\/app\.bullpen\.fi\/predictions\/polymarket\/event/,
  );
  assert.match(marketLinks, /url\.searchParams\.set\("marketSlug", normalizedMarketSlug\)/);
  assert.match(marketLinks, /url\.searchParams\.set\("outcome", outcome\)/);
  assert.match(marketLinks, /url\.searchParams\.set\("ref", BULLPEN_REFERRAL_CODE\)/);
  assert.match(marketLinks, /url\.searchParams\.set\("marketId", normalizedMarketId\)/);
});

test("resolver gets canonical slugs from Gamma before redirecting", () => {
  assert.match(
    marketLinkRoute,
    /POLYMARKET_GAMMA_MARKETS_URL = "https:\/\/gamma-api\.polymarket\.com\/markets"/,
  );
  assert.match(marketLinkRoute, /gammaUrl\.searchParams\.append\("id", marketId\)/);
  assert.match(marketLinkRoute, /\["slug", "marketSlug", "questionSlug"\]/);
  assert.match(marketLinkRoute, /\["eventSlug", "urlSlug"\]/);
  assert.match(marketLinkRoute, /readNestedEventSlug\(market\)/);
  assert.match(marketLinkRoute, /buildBullpenCanonicalMarketUrl\(\{/);
  assert.match(marketLinkRoute, /outcome: "Yes"/);
  assert.match(marketLinkRoute, /NextResponse\.redirect\([\s\S]*?307/);
});
