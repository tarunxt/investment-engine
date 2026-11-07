'use client';
import { Button } from '@/components/ui/button';
import { loadIexDisplayEstimates, loadIexDisplayListings, refreshBasketIexPrices, type IexDisplayState } from '@/lib/alpacaIexDisplaySession';

export function AlpacaIexDisplayControls({ state, automatic = false }: { state: IexDisplayState; automatic?: boolean }) {
  return <>
    <div className="my-3 flex flex-wrap gap-2">
      {automatic ? <Button type="button" size="sm" disabled={state.loading} onClick={() => void refreshBasketIexPrices()}>Refresh Alpaca prices</Button> : <>
      <Button type="button" variant="outline" size="sm" disabled={state.loading} onClick={() => void loadIexDisplayListings()}>Load verified listings</Button>
      <Button type="button" size="sm" disabled={state.loading || !state.listings.length} onClick={() => void loadIexDisplayEstimates()}>Load Alpaca last trades</Button></>}
    </div>
    {state.loading ? <p role="status">Loading display data…</p> : null}
    {state.error ? <p role="alert" className="mb-3 text-sm text-red-800">{state.error}</p> : null}
    {state.reason ? <p role="status" className="mb-3 text-sm text-gray-700">{state.reason}</p> : null}
  </>;
}
