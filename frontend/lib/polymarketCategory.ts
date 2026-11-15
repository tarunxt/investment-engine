const CATEGORY_TRAIL_SEPARATOR = " · ";
const CATEGORY_SCALAR_KEYS = [
  "category",
  "primaryCategory",
  "categoryName",
  "topic",
  "categoryLabel",
  "subcategoryLabel",
  "subcategoryName",
  "parentCategoryLabel",
  "tag",
  "group",
  "type",
];
const CATEGORY_COLLECTION_KEYS = [
  "tags",
  "categories",
  "breadcrumbItems",
  "primaryTag",
  "categoryBreadcrumb",
];
const CATEGORY_OBJECT_LABEL_KEYS = [
  "label",
  "name",
  "title",
  "categoryLabel",
  "subcategoryLabel",
  "subcategoryName",
  "categoryName",
  "primaryCategory",
  "topic",
  "category",
];
const GENERIC_NON_CATEGORY_LABELS = new Set([
  "binary",
  "event",
  "events",
  "featured",
  "group",
  "market",
  "markets",
  "multiple choice",
  "series",
  "tag",
]);

function splitCategoryTrail(value: unknown) {
  const normalized = normalizeCategoryLabel(value);
  if (!normalized) return [];

  return normalized
    .split(/\s*·\s*/g)
    .map((part) => normalizeCategoryLabel(part))
    .filter((part): part is string => {
      if (typeof part !== "string") return false;
      return (
        !isMissingCategory(part) &&
        !GENERIC_NON_CATEGORY_LABELS.has(part.toLowerCase())
      );
    });
}

function readCategoryObjectLabel(value: Record<string, unknown>) {
  for (const key of CATEGORY_OBJECT_LABEL_KEYS) {
    const label = normalizeCategoryLabel(value[key]);
    if (label) return label;
  }

  return null;
}

function appendCategoryLabels(
  target: string[],
  seen: Set<string>,
  value: unknown,
) {
  if (Array.isArray(value)) {
    value.forEach((item) => appendCategoryLabels(target, seen, item));
    return;
  }

  const labels =
    value && typeof value === "object"
      ? splitCategoryTrail(readCategoryObjectLabel(value as Record<string, unknown>))
      : splitCategoryTrail(value);

  for (const label of labels) {
    const normalized = label.toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    target.push(label);
  }
}

function normalizeCategoryTrail(value: unknown) {
  return formatPolymarketCategory(
    Array.isArray(value) ? value : splitCategoryTrail(value),
  );
}

export const POLYMARKET_DEFAULT_CATEGORY = "Uncategorized";

const INFERRED_CATEGORY_RULES: Array<{
  category: string;
  patterns: readonly RegExp[];
}> = [
  {
    category: "Sports",
    patterns: [
      /\b(?:assists?|goals?|shots?|shots on target|saves?|tackles?|cards?|player props?)\b/i,
      /\b(?:nba|nfl|mlb|nhl|ncaa|soccer|football|baseball|basketball|cricket|tennis|wimbledon|atp|wta|ufc|mma|boxing|golf|formula 1|f1|world cup|premier league|champions league|la liga)\b/i,
      /\b[A-Za-z][A-Za-z .'\-]{2,40}\s+vs\.?\s+[A-Za-z][A-Za-z .'\-]{2,40}\b/i,
    ],
  },
  {
    category: "Weather",
    patterns: [
      /\b(?:weather|temperature|rain|snow|hurricane|storm|tornado|heatwave|forecast|climate|wind|precipitation|monsoon|floods?)\b/i,
    ],
  },
  {
    category: "Finance",
    patterns: [
      /\b(?:bitcoin|ethereum|solana|dogecoin|crypto|stock|stocks|share price|nasdaq|s&p|dow|oil|gold|silver|yield|bonds?|commodit(?:y|ies)|forex|inflation|interest rate|fed|etf)\b/i,
    ],
  },
  {
    category: "Politics",
    patterns: [
      /\b(?:election|president|senate|congress|parliament|minister|government|mou|treaty|ceasefire|sanctions?|iran|trump|biden|putin|zelenskyy|netanyahu)\b/i,
    ],
  },
  {
    category: "Social Media",
    patterns: [
      /\b(?:tweets?|x posts?|posts on x|truth social posts?|truths?)\b/i,
    ],
  },
];

export function normalizeCategoryLabel(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") return null;

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

export function isMissingCategory(value: unknown) {
  const normalized = normalizeCategoryLabel(value);
  return !normalized || normalized.toLowerCase() === "uncategorized";
}

export function inferPolymarketCategoryFromText(
  ...values: Array<string | null | undefined>
) {
  const searchText = values
    .map((value) => normalizeCategoryLabel(value)?.toLowerCase())
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (!searchText) return null;

  const matchedRule = INFERRED_CATEGORY_RULES.find((rule) =>
    rule.patterns.some((pattern) => pattern.test(searchText)),
  );
  return matchedRule?.category ?? null;
}

export function collectPolymarketCategoryLabels(recordOrPayload: unknown) {
  const labels: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<unknown>();
  const stack: unknown[] = [recordOrPayload];
  let inspected = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }

    if (typeof current !== "object") {
      appendCategoryLabels(labels, seen, current);
      continue;
    }

    if (visited.has(current)) continue;
    visited.add(current);
    inspected += 1;

    if (inspected > 10_000) break;

    const record = current as Record<string, unknown>;

    CATEGORY_SCALAR_KEYS.forEach((key) =>
      appendCategoryLabels(labels, seen, record[key]),
    );
    CATEGORY_COLLECTION_KEYS.forEach((key) => {
      const value = record[key];
      appendCategoryLabels(labels, seen, value);
    });

    for (const child of Object.values(record)) {
      stack.push(child);
    }
  }

  return labels;
}

export function formatPolymarketCategory(
  labels: ReadonlyArray<string | null | undefined>,
) {
  const nextLabels: string[] = [];
  const seen = new Set<string>();

  for (const value of labels) {
    for (const label of splitCategoryTrail(value)) {
      const normalized = label.toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      nextLabels.push(label);
    }
  }

  return nextLabels.length > 0
    ? nextLabels.join(CATEGORY_TRAIL_SEPARATOR)
    : null;
}

export function shouldReplaceCategory(
  currentCategory: string | null | undefined,
  resolvedCategory: string | null | undefined,
) {
  const normalizedCurrent = normalizeCategoryTrail(currentCategory);
  const normalizedResolved = normalizeCategoryTrail(resolvedCategory);

  if (!normalizedResolved) return false;
  if (!normalizedCurrent) return true;
  if (normalizedCurrent.toLowerCase() === normalizedResolved.toLowerCase()) {
    return false;
  }

  const currentLabels = splitCategoryTrail(normalizedCurrent);
  const resolvedLabels = splitCategoryTrail(normalizedResolved);
  if (resolvedLabels.length <= currentLabels.length) {
    return false;
  }

  return currentLabels.every(
    (label, index) =>
      resolvedLabels[index]?.toLowerCase() === label.toLowerCase(),
  );
}
