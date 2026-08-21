export const DEFAULT_ZERODHA_BUY_THRESHOLD = 2.5;

export type ZerodhaBasketSelectableOrder = {
  id: string;
  side: "BUY" | "SELL";
  score: number | null;
};

export function isEligibleZerodhaBuyOrder(
  order: ZerodhaBasketSelectableOrder,
  threshold: number = DEFAULT_ZERODHA_BUY_THRESHOLD,
) {
  return order.side === "BUY"
    && order.score !== null
    && Number.isFinite(order.score)
    && order.score > threshold;
}

export function buildDefaultZerodhaBasketSelection(
  orders: ZerodhaBasketSelectableOrder[],
  threshold: number = DEFAULT_ZERODHA_BUY_THRESHOLD,
) {
  return new Set(
    orders
      .filter((order) => order.side !== "BUY" || isEligibleZerodhaBuyOrder(order, threshold))
      .map((order) => order.id),
  );
}

export function syncZerodhaBasketBuySelection(
  currentSelectedIds: Set<string>,
  orders: ZerodhaBasketSelectableOrder[],
  threshold: number = DEFAULT_ZERODHA_BUY_THRESHOLD,
) {
  const next = new Set<string>();
  const ordersById = new Map(orders.map((order) => [order.id, order]));

  currentSelectedIds.forEach((id) => {
    const order = ordersById.get(id);
    if (order && order.side !== "BUY") next.add(id);
  });

  orders.forEach((order) => {
    if (isEligibleZerodhaBuyOrder(order, threshold)) next.add(order.id);
  });

  return next;
}
