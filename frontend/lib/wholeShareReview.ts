export type WholeShareChoice = "required" | "keep" | "exit";
export type WholeShareReviewOrder = {
  side: "BUY" | "SELL"; units: number | null; currentUnits: number | null;
  wholeShareReview?: WholeShareChoice;
};

export function needsWholeShareTrimReview(held: number | null, requested: number | null, allowFractional = false) {
  return !allowFractional && held !== null && Number.isFinite(held) && held > 0
    && requested !== null && Number.isFinite(requested) && requested > 0 && requested < 1;
}

export function isWholeShareOrderSelectable(order: WholeShareReviewOrder) {
  if (order.wholeShareReview === "required" || order.wholeShareReview === "keep") return false;
  if (order.wholeShareReview === "exit") return order.side === "SELL" && order.currentUnits === 1 && order.units === 1;
  return order.units !== null && Number.isFinite(order.units) && order.units > 0;
}

export function assertWholeShareOrdersReviewed(orders: WholeShareReviewOrder[]) {
  if (orders.some(order => order.wholeShareReview && !isWholeShareOrderSelectable(order))) {
    throw new Error("Whole-share trim review is unresolved or no order was chosen. Review and separately select a valid full exit before continuing.");
  }
}
