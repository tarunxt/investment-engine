import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("Bullpen History event names use the canonical-link resolver", () => {
  assert.match(
    trendsTable,
    /import \{ buildBullpenMarketUrl \} from "@\/lib\/bullpenMarketLinks"/,
  );
  assert.match(
    trendsTable,
    /href=\{buildBullpenMarketUrl\(event\.market_id\)\}/,
  );
  assert.match(marketLinks, /BULLPEN_LINK_RESOLVER_PATH = "\/api\/bullpen-ai\/market-link"/);
  assert.doesNotMatch(
    marketLinks,
    /BULLPEN_EVENT_BASE_URL[\s\S]*?\/predictions\/market/,
  );
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
