'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDashboard } from '@/app/console/dashboard/_context';
import {
  getSwingTradeCurrencyCode,
  getSwingTradeDefaultInvestmentAmount,
  type SwingTradeMarket,
} from '@/lib/swingTrade';

export function SwingTradeInvestmentAmountField({
  market,
}: {
  market: SwingTradeMarket;
}) {
  const { exportInvestmentAmount, setExportInvestmentAmount } = useDashboard();
  const currencyCode = getSwingTradeCurrencyCode(market);
  const defaultAmount = getSwingTradeDefaultInvestmentAmount(market);
  const inputId = `swing-trade-investment-amount-${market}`;

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
      <Label htmlFor={inputId} className="text-xs font-semibold uppercase tracking-wide text-gray-600">
        Investment Amount
      </Label>
      <div className="mt-2 overflow-hidden rounded-md border border-gray-300 bg-white shadow-sm">
        <div className="flex items-center">
          <span className="border-r border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-gray-600">
            {currencyCode}
          </span>
          <Input
            id={inputId}
            type="text"
            inputMode="decimal"
            placeholder={defaultAmount}
            value={exportInvestmentAmount}
            onChange={(event) => setExportInvestmentAmount(event.target.value)}
            className="border-0 shadow-none focus-visible:ring-0"
          />
        </div>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Used in the default swing-trade prompt and export metadata.
      </p>
    </div>
  );
}
