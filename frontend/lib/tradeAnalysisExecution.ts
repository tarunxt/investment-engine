import type { BullpenTradeAnalysisListItem } from '@/types/api';

/** Requested amounts are intent, never evidence of a filled order. */
export function tradeExecutionFill(item: BullpenTradeAnalysisListItem, side: 'buy' | 'sell') {
  return side === 'buy'
    ? { amount: item.buy_filled_amount, shares: item.buy_filled_shares,
        price: item.buy_average_fill_price, odds: item.buy_average_fill_odds }
    : { amount: item.sell_filled_amount, shares: item.sell_filled_shares,
        price: item.sell_average_fill_price, odds: item.sell_average_fill_odds };
}

export function tradeOutcomeLabel(item: BullpenTradeAnalysisListItem): string {
  if (!item.buy_executed_at && !item.bought_at && !item.is_squared_off) {
    return 'EXECUTION_UNCONFIRMED';
  }
  if (item.pnl_outcome_tag && item.pnl_outcome_tag !== 'OPEN') return item.pnl_outcome_tag;
  return item.is_squared_off ? 'REALIZED' : 'OPEN';
}
