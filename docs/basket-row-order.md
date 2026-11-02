# Basket row order

The shared India Place Order Basket and INDmoney Final Order Basket group rows by **Action New**, in this order:
Sell All, Trim, Buy New, Buy More (internally `Add more`), Hold, Unavailable.
There is currently no explicit row-sort control. Column dragging changes columns,
not stock order.

Within Sell All and Trim, finite calculated scores sort ascending. Within Buy New
and Buy More, they sort descending. Missing or non-finite scores come last.
Ties sort by symbol, case-insensitive with numeric comparison. Identical symbol
and score retain their source order, including exact-venue rows. Hold and
Unavailable use finite-score availability followed by symbol, without score
magnitude ordering.

Editable drafts in both brokers use Action New as their sort identity. Units, percentage,
Amount, checkbox selection and calculation-popup state are not sort inputs.
Reducing a Sell All quantity below the full holding must not move it into a
hidden Trim subgroup of its unchanged visible Sell All section. The prior sorter
mistakenly used the legacy percentage-derived action for those draft rows.

A new snapshot, changed score dataset, or explicit allocation parameter change
can intentionally change Action New sections and their default order. Refreshing
values alone cannot change ordering through Units or Amount. This change adds no
row-sort control, persistent custom stock order or order-submission behavior.
Legacy baskets without editable draft context retain their previous comparator.

Offline regressions execute the actual production comparator and an offline
browser fixture with external requests blocked. They cover manual decrease and
increase, crossing 100%, zero quantity, reactive Amount, selection, repeated
popup renders, ties, exact-venue identity and new-score ordering. They are not
production browser acceptance or authorization to place an order.


INDmoney USD estimates retain fractional shares. Target Amount is Target Weight
(as a fraction) × (current holdings value + parsed USD wallet balance); Action
Amount subtracts the stock's invested value, as explicitly requested. Shares
divide those unrounded amounts by a verified vendor LTP. A difference between
invested-cost action direction and current-value Action New blocks readiness.
Missing margin, price or invested value is unavailable, never silently zero.

The shared table exposes the same nine calculated columns for both brokers;
the four Action/Target sizing labels use the broker name. Raw/effective score
explanations appear only in Historical Weighted Score details. Original saved
scores and stage colours are unchanged.

US vendor integration is intentionally unresolved: the existing Google Finance
HTML scraper is not expanded to this basket. The US quote adapter fails closed
with an explicit error until an approved display feed with exact listing and
source trade time is configured. Receipt time is not a trade timestamp.
Generic US and competing explicit venues are excluded from allocation until a
verified listing mapping is available; no symbol-only alias merge is performed.
Original rows/history remain visible for review. Partial sources and oversized
sell estimates cannot be reported ready. This is not broker execution support.
