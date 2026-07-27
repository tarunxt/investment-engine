import type { BullpenQuestionRow } from "@/lib/bullpen-ai";
import type { BullpenAutoLiveDecision } from "@/types/api";

import type { BullpenAutoRunActivePositionView } from "./bullpenAutoRunProgress";

export type BullpenStage2ActionableItem = {
  id: string;
  marketId: string | null;
  title: string;
  marketUrl: string | null;
  slug: string | null;
  theme: string | null;
  side: string | null;
  reason: string;
  rank: number | null;
  currentExposureUsd: number | null;
  targetExposureUsd: number | null;
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  returnsPerDay: number | null;
};

export type BullpenStage2ActionablesView = {
  eventExits: BullpenStage2ActionableItem[];
  buyNew: BullpenStage2ActionableItem[];
  hold: BullpenStage2ActionableItem[];
};

type BuildBullpenStage2ActionablesInput = {
  activePositions: BullpenAutoRunActivePositionView[];
  decisions: BullpenAutoLiveDecision[];
  selectedRows: BullpenQuestionRow[];
};

function normalizeKey(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function uniqueKeys(values: Array<string | null | undefined>) {
  return [...new Set(values.map(normalizeKey).filter((value): value is string => Boolean(value)))];
}

function activePositionKeys(position: BullpenAutoRunActivePositionView) {
  return uniqueKeys([
    position.marketId,
    position.slug,
    position.marketUrl,
    position.marketTitle,
  ]);
}

function decisionKeys(decision: BullpenAutoLiveDecision) {
  return uniqueKeys([
    decision.market_id,
    decision.slug,
    decision.market_url,
    decision.market_title,
  ]);
}

function selectedRowKeys(row: BullpenQuestionRow) {
  return uniqueKeys([row.marketId, row.slug, row.marketUrl, row.question, row.id]);
}

function sharesAnyKey(left: string[], right: string[]) {
  const rightKeys = new Set(right);
  return left.some((key) => rightKeys.has(key));
}

function isActivePosition(position: BullpenAutoRunActivePositionView) {
  return (
    !position.isClaimable &&
    (position.classification === null || position.classification === "active")
  );
}

function isExitDecision(decision: BullpenAutoLiveDecision) {
  return decision.decision === "EXIT" || decision.order_plan?.action === "sell";
}

function isBuyNewDecision(decision: BullpenAutoLiveDecision) {
  return decision.decision === "BUY_NEW" || decision.order_plan?.action === "buy";
}

function findMatchingDecisions(
  keys: string[],
  decisions: BullpenAutoLiveDecision[],
) {
  return decisions.filter((decision) => sharesAnyKey(keys, decisionKeys(decision)));
}

function buildActivePositionItem({
  position,
  reason,
  rank,
  decision,
}: {
  position: BullpenAutoRunActivePositionView;
  reason: string;
  rank: number | null;
  decision?: BullpenAutoLiveDecision | null;
}): BullpenStage2ActionableItem {
  return {
    id: position.positionKey,
    marketId: position.marketId,
    title: position.marketTitle,
    marketUrl: position.marketUrl,
    slug: position.slug,
    theme: position.theme,
    side: position.side,
    reason,
    rank,
    currentExposureUsd:
      decision?.current_exposure_usd ?? position.exposureUsd ?? null,
    targetExposureUsd: decision?.target_exposure_usd ?? null,
    llmYesOdds: decision?.fair_yes_probability_pct ?? null,
    llmNoOdds: decision?.fair_no_probability_pct ?? null,
    returnsPerDay: null,
  };
}

function buildSelectedRowItem({
  row,
  rank,
  decision,
}: {
  row: BullpenQuestionRow;
  rank: number;
  decision?: BullpenAutoLiveDecision | null;
}): BullpenStage2ActionableItem {
  return {
    id: row.marketId ?? row.id,
    marketId: row.marketId,
    title: row.question,
    marketUrl: row.marketUrl,
    slug: row.slug,
    theme: row.category,
    side:
      decision?.side ??
      ((row.llmYesOdds ?? Number.NEGATIVE_INFINITY) >=
      (row.llmNoOdds ?? Number.NEGATIVE_INFINITY)
        ? "YES"
        : "NO"),
    reason:
      decision?.reason?.trim() ||
      "Selected by the Stage 2 LLM ranking as a new Bullpen opportunity.",
    rank: decision?.stage3_final_rank ?? rank,
    currentExposureUsd: decision?.current_exposure_usd ?? 0,
    targetExposureUsd:
      decision?.target_exposure_usd ?? row.amountToBeInvested ?? null,
    llmYesOdds: decision?.fair_yes_probability_pct ?? row.llmYesOdds,
    llmNoOdds: decision?.fair_no_probability_pct ?? row.llmNoOdds,
    returnsPerDay: row.returnsPerDay,
  };
}

function buildDecisionItem(
  decision: BullpenAutoLiveDecision,
): BullpenStage2ActionableItem {
  return {
    id: decision.id,
    marketId: decision.market_id,
    title: decision.market_title,
    marketUrl: decision.market_url,
    slug: decision.slug,
    theme: decision.theme,
    side: decision.side,
    reason:
      decision.reason?.trim() ||
      "Identified by the latest Bullpen LLM and Stage 3 decision projection.",
    rank: decision.stage3_final_rank ?? null,
    currentExposureUsd: decision.current_exposure_usd,
    targetExposureUsd: decision.target_exposure_usd,
    llmYesOdds: decision.fair_yes_probability_pct,
    llmNoOdds: decision.fair_no_probability_pct,
    returnsPerDay: null,
  };
}

function actionableIdentity(item: BullpenStage2ActionableItem) {
  return (
    uniqueKeys([item.marketId, item.slug, item.marketUrl, item.title])[0] ?? item.id
  );
}

function dedupeItems(items: BullpenStage2ActionableItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = actionableIdentity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build the post-LLM Stage 2 action summary without inventing new trading facts.
 * Explicit EXIT/BUY_NEW decisions take priority. When Stage 2 has a selected
 * portfolio, active positions omitted from it are displaced exits and selected
 * non-active rows are new buys. Every remaining active position is a hold.
 */
export function buildBullpenStage2Actionables({
  activePositions,
  decisions,
  selectedRows,
}: BuildBullpenStage2ActionablesInput): BullpenStage2ActionablesView {
  const liveActivePositions = activePositions.filter(isActivePosition);
  const selectedEntries = selectedRows.map((row, index) => ({
    row,
    rank: index + 1,
    keys: selectedRowKeys(row),
  }));
  const hasSelectedPortfolio = selectedEntries.length > 0;
  const eventExits: BullpenStage2ActionableItem[] = [];
  const hold: BullpenStage2ActionableItem[] = [];

  for (const position of liveActivePositions) {
    const keys = activePositionKeys(position);
    const matchingDecisions = findMatchingDecisions(keys, decisions);
    const exitDecision = matchingDecisions.find(isExitDecision) ?? null;
    const selectedEntry = selectedEntries.find((entry) =>
      sharesAnyKey(keys, entry.keys),
    );

    if (exitDecision || (hasSelectedPortfolio && !selectedEntry)) {
      eventExits.push(
        buildActivePositionItem({
          position,
          decision: exitDecision,
          rank: exitDecision?.stage3_final_rank ?? null,
          reason:
            exitDecision?.reason?.trim() ||
            "Outside the Stage 2 selected portfolio after the latest LLM ranking.",
        }),
      );
      continue;
    }

    const retainedDecision = matchingDecisions.find(
      (decision) => !isExitDecision(decision),
    );
    hold.push(
      buildActivePositionItem({
        position,
        decision: retainedDecision,
        rank:
          retainedDecision?.stage3_final_rank ?? selectedEntry?.rank ?? null,
        reason:
          retainedDecision?.reason?.trim() ||
          (selectedEntry
            ? "Retained inside the Stage 2 selected portfolio after the latest LLM ranking."
            : "No Event Exit was identified for this active Bullpen position."),
      }),
    );
  }

  const activeKeySets = liveActivePositions.map(activePositionKeys);
  const buyNew: BullpenStage2ActionableItem[] = selectedEntries
    .filter(
      (entry) =>
        !activeKeySets.some((activeKeys) => sharesAnyKey(activeKeys, entry.keys)),
    )
    .map((entry) => {
      const decision = findMatchingDecisions(entry.keys, decisions).find(
        isBuyNewDecision,
      );
      return buildSelectedRowItem({
        row: entry.row,
        rank: entry.rank,
        decision,
      });
    });

  for (const decision of decisions.filter(isBuyNewDecision)) {
    const keys = decisionKeys(decision);
    const belongsToActivePosition = activeKeySets.some((activeKeys) =>
      sharesAnyKey(activeKeys, keys),
    );
    if (!belongsToActivePosition) {
      buyNew.push(buildDecisionItem(decision));
    }
  }

  return {
    eventExits: dedupeItems(eventExits),
    buyNew: dedupeItems(buyNew),
    hold: dedupeItems(hold),
  };
}
