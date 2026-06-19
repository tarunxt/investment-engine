import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../app/console/dashboard/_components/RebalanceWorkflowSections.tsx", import.meta.url),
  "utf8",
);

assert.match(source, /type ZerodhaExecutionMode = "direct_market" \| "publisher_limit";/);
assert.match(source, /Open Kite protected LIMIT basket/);
assert.match(source, /Place protected MARKET/);
assert.match(source, /Publisher-safe fallback uses \/connect\/basket only for protected LIMIT orders/);
assert.doesNotMatch(source, /Market with Zerodha auto protection/);

const MARKET_INTENT_ACTIONS = new Set(["Buy New", "Add more", "Sell All", "Trim"]);
const staleRecommendationPrices = new Set([580, 5450, 778]);

function ceilToTick(value, tick = 0.05) {
  return Number((Math.ceil(value / tick) * tick).toFixed(2));
}
function floorToTick(value, tick = 0.05) {
  return Number((Math.floor(value / tick) * tick).toFixed(2));
}
function protectedLimitPrice(order, protectionPct = 0.01) {
  if (order.side === "BUY") return Math.min(ceilToTick(order.lastPrice * (1 + protectionPct)), order.upperCircuit);
  return Math.max(floorToTick(order.lastPrice * (1 - protectionPct)), order.lowerCircuit);
}
function buildPublisherBasketPayload(orders, marketOpen = true) {
  return orders.map((order) => {
    const price = MARKET_INTENT_ACTIONS.has(order.action)
      ? protectedLimitPrice(order)
      : order.price;
    return {
      variety: order.orderKind === "After market" || !marketOpen ? "amo" : "regular",
      tradingsymbol: order.symbol.toUpperCase(),
      exchange: order.exchange.toUpperCase(),
      transaction_type: order.side,
      order_type: "LIMIT",
      quantity: Math.max(1, Math.floor(order.units ?? 0)),
      product: "CNC",
      validity: "DAY",
      readonly: false,
      tag: "credx",
      price: Number(price.toFixed(2)),
    };
  });
}

const rows = [
  { symbol: "PFC", exchange: "NSE", side: "BUY", action: "Buy New", units: 18, price: 580, lastPrice: 431, upperCircuit: 517.2, lowerCircuit: 344.8, orderKind: "Market" },
  { symbol: "HAL", exchange: "NSE", side: "BUY", action: "Buy New", units: 2, price: 5450, lastPrice: 4402.5, upperCircuit: 5283, lowerCircuit: 3522, orderKind: "Market" },
  { symbol: "HINDALCO", exchange: "NSE", side: "BUY", action: "Buy New", units: 13, price: 778, lastPrice: 1011.9, upperCircuit: 1214.25, lowerCircuit: 809.55, orderKind: "Market" },
];

const payload = buildPublisherBasketPayload(rows);
for (const order of payload) {
  assert.equal(order.order_type, "LIMIT");
  assert.equal(Object.hasOwn(order, "market_protection"), false);
  assert.equal(staleRecommendationPrices.has(order.price), false);
}
assert.equal(payload[0].price, 435.35);
assert.equal(payload[1].price, 4446.55);
assert.equal(payload[2].price, 1022.05);
assert.equal(payload.some((order) => order.order_type === "MARKET"), false);
