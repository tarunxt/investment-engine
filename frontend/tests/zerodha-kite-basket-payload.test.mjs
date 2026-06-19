import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../app/console/dashboard/_components/RebalanceWorkflowSections.tsx", import.meta.url),
  "utf8",
);

assert.match(source, /const ZERODHA_MARKET_INTENT_ACTIONS = new Set<ActionCategory>\(\["Buy New", "Add more", "Sell All", "Trim"\]\);/);
assert.match(source, /orderType: isMarketIntent \? "MARKET" as const : "LIMIT" as const/);
assert.match(source, /payload\.market_protection = ZERODHA_DEFAULT_MARKET_PROTECTION;/);
assert.doesNotMatch(source, /orderType: "LIMIT" as const,\n\s*variety,/);
assert.doesNotMatch(source, /Protected LIMIT/);

const MARKET_INTENT_ACTIONS = new Set(["Buy New", "Add more", "Sell All", "Trim"]);
const DEFAULT_MARKET_PROTECTION = -1;

function buildKiteBasketPayload(orders, marketOpen = true) {
  return orders.map((order) => {
    const isMarketIntent = order.orderKind !== "Limit" && MARKET_INTENT_ACTIONS.has(order.action);
    const orderType = isMarketIntent ? "MARKET" : "LIMIT";
    const payload = {
      variety: order.orderKind === "After market" || !marketOpen ? "amo" : "regular",
      tradingsymbol: order.symbol.toUpperCase(),
      exchange: order.exchange.toUpperCase(),
      transaction_type: order.side,
      order_type: orderType,
      quantity: Math.max(1, Math.floor(order.units ?? 0)),
      product: "CNC",
      validity: "DAY",
      readonly: false,
      tag: "credx",
    };
    if (orderType === "MARKET") {
      payload.market_protection = DEFAULT_MARKET_PROTECTION;
    } else if (order.price) {
      payload.price = Number(order.price.toFixed(2));
    }
    return payload;
  });
}

const rows = [
  { symbol: "PFC", exchange: "NSE", side: "BUY", action: "Buy New", units: 18, price: 580, orderKind: "Market" },
  { symbol: "HAL", exchange: "NSE", side: "BUY", action: "Buy New", units: 2, price: 5450, orderKind: "Market" },
  { symbol: "HINDALCO", exchange: "NSE", side: "BUY", action: "Buy New", units: 13, price: 778, orderKind: "Market" },
  { symbol: "INFY", exchange: "NSE", side: "BUY", action: "Hold", units: 3, price: 143.8, orderKind: "Limit" },
];

const payload = buildKiteBasketPayload(rows);
assert.deepEqual(payload[0], {
  variety: "regular",
  tradingsymbol: "PFC",
  exchange: "NSE",
  transaction_type: "BUY",
  order_type: "MARKET",
  quantity: 18,
  product: "CNC",
  validity: "DAY",
  readonly: false,
  tag: "credx",
  market_protection: -1,
});
for (const marketOrder of payload.slice(0, 3)) {
  assert.equal(marketOrder.order_type, "MARKET");
  assert.equal(marketOrder.market_protection, -1);
  assert.equal(Object.hasOwn(marketOrder, "price"), false);
  assert.equal(Object.hasOwn(marketOrder, "trigger_price"), false);
}
assert.equal(payload[3].order_type, "LIMIT");
assert.equal(payload[3].price, 143.8);
