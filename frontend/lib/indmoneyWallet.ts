import type { IndMoneyUsPortfolioSnapshotDetail } from "@/types/api";

/** Recover the icon-only wallet header from this saved paste. Other dollar amounts
 * on the same page describe investments, returns or buying power. */
export function recoverIndmoneyWallet(snapshot: IndMoneyUsPortfolioSnapshotDetail) {
  if (snapshot.wallet_balance != null || !snapshot.raw_text) return snapshot;
  const lines = snapshot.raw_text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const end = lines.findIndex(line => line.toLowerCase() === "current value");
  if (end < 0) return snapshot;
  const amounts = new Set<number>();
  for (let i = 2; i < end; i++) {
    if (lines[i].toLowerCase() !== "add money" || lines[i - 2].toLowerCase() !== "my portfolio") continue;
    const match = /^([+-]?)\$\s*(\d+|\d{1,3}(?:,\d{3})+)(\.\d{2})?$/.exec(lines[i - 1]);
    if (!match) continue;
    const amount = Number(match[1] + match[2].replaceAll(",", "") + (match[3] ?? ""));
    if (Number.isSafeInteger(Math.round(amount * 100))) amounts.add(amount);
  }
  if (amounts.size !== 1) return snapshot;
  return { ...snapshot, wallet_balance: [...amounts][0] };
}
