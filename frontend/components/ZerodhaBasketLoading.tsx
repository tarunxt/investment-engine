/** Static status indicators also respect reduced-motion preferences. */
export function ZerodhaBasketLoading() {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="flex justify-center py-16 text-blue-600">
      <div className="relative min-h-[68px] max-w-full pl-[27.5px] pt-[11px] text-left">
        <span aria-hidden="true" className="absolute left-0 top-0 h-[68px] w-[3px] bg-current" />
        <span className="block text-[clamp(18px,4.5vw,29px)] font-normal leading-[35px]">Preparing Zerodha Basket</span>
        <span aria-hidden="true" className="mt-[14px] flex h-1 gap-[7px] pl-[0.5px]">
          <span className="size-1 rounded-full bg-current" />
          <span className="size-1 rounded-full bg-current opacity-[0.55]" />
          <span className="size-1 rounded-full bg-current opacity-25" />
        </span>
      </div>
    </div>
  );
}
