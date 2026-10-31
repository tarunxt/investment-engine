# Basket row order

The India Place Order Basket groups rows by **Action New**, in this order:
Sell All, Trim, Buy New, Buy More (internally `Add more`), Hold, Unavailable.
There is currently no explicit row-sort control. Column dragging changes columns,
not stock order.

Within Sell All and Trim, finite calculated scores sort ascending. Within Buy New
and Buy More, they sort descending. Missing or non-finite scores come last.
Ties sort by symbol, case-insensitive with numeric comparison. Identical symbol
and score retain their source order, including exact-venue rows. Hold and
Unavailable use finite-score availability followed by symbol, without score
magnitude ordering.

Editable India drafts use Action New as their sort identity. Units, percentage,
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
