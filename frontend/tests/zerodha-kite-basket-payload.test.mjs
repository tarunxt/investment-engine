import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../app/console/dashboard/_components/RebalanceWorkflowSections.tsx", import.meta.url),
  "utf8",
);

assert.match(source, /type ZerodhaExecutionMode = "direct_market" \| "publisher_limit";/);
assert.match(source, /Open Kite protected LIMIT basket/);
assert.match(source, /Place protected MARKET/);
assert.match(source, /Protected MARKET: Sell first, then buy/);
assert.match(source, /Refresh LTP/);
assert.match(source, /Quoted LTP refreshed/);
assert.match(source, /Quoted LTP/);
assert.match(source, /Buy Threshold/);
assert.match(source, /Buy New and Buy More rows auto-select only when the Final Score is greater than the Buy threshold/);
assert.match(source, /Publisher-safe fallback uses \/connect\/basket only for protected LIMIT orders/);
assert.match(source, /SELL trays first/);
assert.match(source, /Refresh & Open Buy Basket/);
assert.doesNotMatch(source, /Sell All, Trim, Buy New, and Buy More actionables are pre-selected/);
assert.doesNotMatch(source, /Market with Zerodha auto protection/);

const MARKET_INTENT_ACTIONS = new Set(["Buy New", "Add more", "Sell All", "Trim"]);
const staleRecommendationPrices = new Set([580, 5450, 778]);

function roundToTick(value, tick = 0.05) {
  return Number((Math.round(value / tick) * tick).toFixed(2));
}
function mirroredLimitPrice(order) {
  const livePrice = order.lastPrice ?? order.price;
  const clampedPrice = Math.min(Math.max(livePrice, order.lowerCircuit), order.upperCircuit);
  return roundToTick(clampedPrice);
}
function buildPublisherBasketPayload(orders, marketOpen = true) {
  return orders.map((order) => {
    const price = MARKET_INTENT_ACTIONS.has(order.action)
      ? mirroredLimitPrice(order)
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
assert.equal(payload[0].price, 431);
assert.equal(payload[1].price, 4402.5);
assert.equal(payload[2].price, 1011.9);
assert.equal(payload.some((order) => order.order_type === "MARKET"), false);

assert.match(source, /projectedBuyPower/);
assert.match(source, /zerodhaPlaceProtectedMarketOrdersSequenced/);
assert.match(source, /selectedRows.*SELL|side === "SELL"/s);
assert.match(source, /allowFractionalSellUnits\?: boolean/);
assert.match(source, /allowFractionalUnits \? availableUnits : Math\.floor\(availableUnits\)/);
assert.match(source, /buildZerodhaBasketPreviewOrders\(actionRows, technicalScans, null, \{ allowFractionalSellUnits: true \}\)/);

assert.match(source, /function hasActiveWorkflowStage\(/);
assert.match(source, /\["queued", "running"\]\.includes\(states\[portfolio\]\[stage\]\.state\)/);
assert.match(source, /const showPauseKillControls = isSectionRunning \|\| hasActiveStage;/);
assert.match(source, /showPauseKillControls \? \(/);
