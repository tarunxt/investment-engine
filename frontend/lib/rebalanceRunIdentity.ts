import type { SwingTradeMarket } from '@/lib/swingTrade';

export type AnalysisRunStage = 'swing' | 'rebalance' | 'technical' | 'threats';
type RunIdentitySource = {
  prompt?: string | null;
  prompt_preview?: string | null;
  auto_rebalance_portfolio?: string | null;
  auto_rebalance_label?: string | null;
};
type AnalysisRunIdentity = { market: SwingTradeMarket | null; stage: AnalysisRunStage | null };

function openingMarket(text: string): SwingTradeMarket | null {
  const india = /\b(?:zerodha|india|indian|nse|bse|inr)\b/i.test(text);
  const us = /\b(?:indmoney|nasdaq|nyse|usd|united states)\b|\b(?:us|u\.s\.)\s+(?:aggressive|equity|equities|stocks|portfolio|swing|rebalance)/i.test(text);
  return india === us ? null : india ? 'india' : 'us';
}

/** Classify the run itself, never a quoted scan or input bundle in its prompt. */
export function getAnalysisRunIdentity(run: RunIdentitySource): AnalysisRunIdentity {
  const unknown: AnalysisRunIdentity = { market: null, stage: null };
  const portfolio = run.auto_rebalance_portfolio;
  if (portfolio && portfolio !== 'india' && portfolio !== 'indmoney_us') return unknown;
  const metadataMarket = portfolio === 'india' ? 'india' : portfolio === 'indmoney_us' ? 'us' : null;
  const label = run.auto_rebalance_label?.trim() ?? '';
  const labelStage = label.match(/\b(swing|rebalance|technical|threats?)\s+scan\)?\s*$/i)?.[1]?.toLowerCase();
  const stageFromLabel = labelStage?.startsWith('threat') ? 'threats' : labelStage as AnalysisRunStage | undefined;
  const labelMarket = /^India Run\b/i.test(label) ? 'india' : /^IndMoney US Run\b/i.test(label) ? 'us' : null;
  if (metadataMarket && labelMarket && metadataMarket !== labelMarket) return unknown;

  const prompt = (run.prompt ?? run.prompt_preview ?? '').trimStart();
  const marker = prompt.match(/^\[REBALANCE_FLOW:(india|us)\]/i);
  const opening = prompt.split(/\n\s*\n/, 1)[0].slice(0, 1000);
  let stageFromPrompt: AnalysisRunStage | null = null;
  let marketFromMarker: SwingTradeMarket | null = null;
  if (marker) {
    stageFromPrompt = 'rebalance';
    marketFromMarker = marker[1].toLowerCase() as SwingTradeMarket;
  } else if (/^##\s*Technical Scan Input Bundle\b/i.test(prompt)) {
    stageFromPrompt = 'technical';
    const usHeader = /^Market:\s*US equities\s*$/im.test(opening);
    const indiaHeader = /^Market:\s*India equities\s*$/im.test(opening);
    if (usHeader && indiaHeader) return unknown;
    marketFromMarker = usHeader ? 'us' : indiaHeader ? 'india' : null;
  } else if (/^\[(?:ZERODHA|INDMONEY_US)_THREATS\]/i.test(prompt)) {
    stageFromPrompt = 'threats';
    marketFromMarker = /^\[ZERODHA_THREATS\]/i.test(prompt) ? 'india' : 'us';
  }
  const explicitMarket = metadataMarket ?? labelMarket;
  // Contradictory explicit identities are not safe inputs for either market.
  if (explicitMarket && marketFromMarker && explicitMarket !== marketFromMarker) return unknown;
  if (stageFromLabel && stageFromPrompt && stageFromLabel !== stageFromPrompt) return unknown;

  const stage = stageFromLabel ?? stageFromPrompt ?? (
    /\brebalanc(?:e|ing)\b/i.test(opening) ? 'rebalance'
      : /\bswing[-\s]*trad(?:e|ing)|\bswing scan\b/i.test(opening) ? 'swing' : null
  );
  return { stage, market: explicitMarket ?? marketFromMarker ?? openingMarket(opening) };
}

export function isAnalysisRunForStage(
  run: RunIdentitySource,
  stage: AnalysisRunStage,
  market?: SwingTradeMarket,
) {
  const identity = getAnalysisRunIdentity(run);
  return identity.stage === stage && identity.market !== null && (!market || identity.market === market);
}
