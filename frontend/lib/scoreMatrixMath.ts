export type ScoreMatrixValidationRule = {
  min?: number;
  max?: number;
  integerOnly?: boolean;
  actualValue?: number | null;
};

export type ScoreMatrixWeightedRow = {
  score: number | null;
  multiplier: number;
  denominatorWeight?: number;
  outOfBoundsDenominatorWeight?: number;
  validationRule?: ScoreMatrixValidationRule;
};

function getScoreMatrixRowActualValue(row: ScoreMatrixWeightedRow) {
  return row.validationRule?.actualValue ?? row.score;
}

export function isScoreMatrixRowOutOfBounds(row: ScoreMatrixWeightedRow) {
  const rule = row.validationRule;
  if (!rule) return false;

  const actualValue = getScoreMatrixRowActualValue(row);
  if (actualValue === null || !Number.isFinite(actualValue)) return false;

  const belowMin = rule.min !== undefined && actualValue < rule.min;
  const aboveMax = rule.max !== undefined && actualValue > rule.max;
  const invalidInteger = Boolean(rule.integerOnly && !Number.isInteger(actualValue));

  return belowMin || aboveMax || invalidInteger;
}

export function getScoreMatrixRowEffectiveMultiplier(row: ScoreMatrixWeightedRow) {
  return isScoreMatrixRowOutOfBounds(row) ? 0 : row.multiplier;
}

export function getScoreMatrixRowDenominatorWeight(row: ScoreMatrixWeightedRow) {
  return row.denominatorWeight ?? Math.abs(row.multiplier);
}

export function getScoreMatrixRowOutOfBoundsDenominatorWeight(row: ScoreMatrixWeightedRow) {
  return row.outOfBoundsDenominatorWeight ?? getScoreMatrixRowDenominatorWeight(row);
}

export function calculateWeightedRationaleScore(
  rows: ScoreMatrixWeightedRow[],
  denominatorOverride?: number | null,
) {
  const defaultDenominatorBase = rows
    .filter((row) => row.multiplier !== 0)
    .reduce((sum, row) => sum + getScoreMatrixRowDenominatorWeight(row), 0);
  const outOfBoundsDenominatorReduction = rows
    .filter((row) => row.multiplier !== 0 && isScoreMatrixRowOutOfBounds(row))
    .reduce((sum, row) => sum + getScoreMatrixRowOutOfBoundsDenominatorWeight(row), 0);
  const defaultDenominator = Math.max(0, defaultDenominatorBase - outOfBoundsDenominatorReduction);
  const denominator = denominatorOverride !== undefined && denominatorOverride !== null
    ? denominatorOverride
    : defaultDenominator;

  if (!denominator) return { finalScore: null, denominator };

  const numerator = rows.reduce(
    (sum, row) => sum + (row.score ?? 0) * getScoreMatrixRowEffectiveMultiplier(row),
    0,
  );

  return { finalScore: numerator / denominator, denominator };
}
