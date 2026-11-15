# Final Actionables render work

Opening Calculations previously parsed the same Swing output once per displayed
stock. Historical reconstruction repeatedly parsed technical jobs for overlapping
time cutoffs. Every closed stock-details button also parsed the complete browser
history cache and prepared its hidden evidence rows.

Swing rows are now reused only within one consensus invocation. Technical rows
are reused within one historical reconstruction, after each run's historical
cutoff filter; the cache checks the exact source-link object, response and parser
metadata. Closed stock details defer optional cache/history/evidence work until
opened. There is no global/account-shared result cache and no source is dropped.
API fetching, score rules, market rounding and execution quantities are unchanged.

Consolidated quantity cells use a presentation-only formatter to hide binary
arithmetic residue and long decimal noise. Raw model cells and underlying values
remain intact; normalized cells expose the original value in a title. Genuine
small quantities remain visible and unknown values are not converted to zero.

Offline profiling used 180 synthetic runs and 13 stocks. Recommendation parses
fell from 1,682 to 242, technical parses from 3,782 to 242, and closed-detail cache
parses from 13 to zero. Full consensus/history output and 526,916-byte modal HTML
had matching hashes for the integer fixture. Modal server rendering measured
7.68 seconds before and 1.85 seconds after on the shared test host. The timings
are indicative; deterministic parse counts and output equality are the regression
gates. Separate decimal fixtures cover the intentional display normalization.

This is not a production page-latency claim. The existing cold full-history API
hydration remains unchanged and must be measured separately in browser QA.
