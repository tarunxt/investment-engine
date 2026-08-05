export type BullpenScanFilterDetailId =
  | "excludeSports"
  | "excludeWeather"
  | "excludeMarketPredictions"
  | "excludeTweetCountQuestions"
  | "excludeReleasedByEvents"
  | "onlyBinaryYesNo";

export type BullpenScanFilterDetail = {
  id: BullpenScanFilterDetailId;
  label: string;
  description: string;
  dialogEyebrow: string;
  title: string;
  matcherScope: string;
  algorithmSteps: string[];
  keywordGroups?: string[];
  patternRules?: string[];
  excludedEventExamples?: string[];
};

const SPORTS_KEYWORD_GROUPS = [
  ["sports", "esports", "games", "match", "tournament"],
  [
    "nba",
    "nfl",
    "mlb",
    "nhl",
    "ncaa",
    "soccer",
    "football",
    "baseball",
    "basketball",
    "cricket",
  ],
  [
    "tennis",
    "wimbledon",
    "atp",
    "wta",
    "grand slam",
    "roland garros",
    "french open",
    "australian open",
  ],
  [
    "davis cup",
    "billie jean king cup",
    "golf",
    "pga",
    "u.s. open",
    "us open",
    "mma",
    "ufc",
    "boxing",
  ],
  [
    "formula 1",
    "f1",
    "dota",
    "counter-strike",
    "cs2",
    "iem",
    "league of legends",
    "lol esports",
    "lck",
    "lpl",
    "msi",
    "mid-season invitational",
    "valorant",
    "team falcons",
    "xtreme gaming",
    "bilibili gaming",
    "world cup",
    "premier league",
    "champions league",
    "la liga",
  ],
] as const;

const WEATHER_KEYWORD_GROUPS = [
  [
    "weather",
    "temperature",
    "rain",
    "snow",
    "hurricane",
    "storm",
    "tornado",
  ],
  [
    "heatwave",
    "forecast",
    "climate",
    "wind",
    "precipitation",
    "monsoon",
  ],
] as const;

const MARKET_CATEGORY_KEYWORD_GROUPS = [
  [
    "finance",
    "business",
    "markets",
    "crypto",
    "economy",
    "economics",
    "stocks",
    "commodities",
    "forex",
  ],
] as const;

const MARKET_QUESTION_KEYWORD_GROUPS = [
  ["bitcoin", "ethereum", "solana", "dogecoin", "memecoin", "crypto"],
  ["stock", "stocks", "share price", "nasdaq", "s&p", "dow"],
  [
    "oil",
    "gold",
    "silver",
    "yield",
    "bond",
    "bonds",
    "commodity",
    "commodities",
    "forex",
  ],
  ["inflation", "interest rate", "fed", "etf"],
] as const;

const SOCIAL_POST_COUNT_KEYWORD_GROUPS = [
  [
    "tweet",
    "tweets",
    "x post",
    "x posts",
    "posts on x",
    "truth social post",
    "truth social posts",
    "truths",
  ],
] as const;

export const SPORTS_KEYWORDS = SPORTS_KEYWORD_GROUPS.flat();
export const WEATHER_KEYWORDS = WEATHER_KEYWORD_GROUPS.flat();
export const MARKET_CATEGORY_KEYWORDS = MARKET_CATEGORY_KEYWORD_GROUPS.flat();
export const MARKET_QUESTION_KEYWORDS = MARKET_QUESTION_KEYWORD_GROUPS.flat();
export const SOCIAL_POST_COUNT_KEYWORDS =
  SOCIAL_POST_COUNT_KEYWORD_GROUPS.flat();

export const RELEASED_BY_EVENT_KEYWORDS = ["released by"] as const;

export function normalizeCustomExclusionKeywordVariants(keyword: string) {
  const normalizedKeywords = keyword
    .split(",")
    .map((part) => part.trim().toLowerCase().replace(/^['"]+|['"]+$/g, ""))
    .filter(Boolean);

  const variants: string[] = [];
  for (const normalized of normalizedKeywords) {
    variants.push(normalized);
    const withoutLeadingOperator = normalized
      .replace(/^(?:\d+\s*)?\+\s+/, "")
      .replace(
        /^(?:at least|at most|over|under|more than|less than)\s+\d+\s+/,
        "",
      )
      .trim();

    if (withoutLeadingOperator && withoutLeadingOperator !== normalized) {
      variants.push(withoutLeadingOperator);
    }
  }

  return Array.from(new Set(variants));
}

export const SOCIAL_POST_COUNT_PATTERNS = [
  /\bhow many (?:tweets?|posts?|truths?)\b/i,
  /\bnumber of (?:tweets?|posts?|truths?)\b/i,
  /\b(?:at least|at most|more than|less than|over|under|between)\s+\d+[\w\s-]*(?:tweets?|posts?|truths?)\b/i,
  /\b\d+\s*(?:-|to)\s*\d+\s+(?:tweets?|posts?|truths?)\b/i,
  /\b\d+\+?\s+(?:tweets?|posts?|truths?)\b/i,
] as const;

export const SPORTS_PATTERNS = [
  /\b(?:both teams to score|exact score|leading at halftime|draw at halftime|penalty shootout|extra time)\b/i,
  /(?:^|\W)(?:\d+\s*)?\+\s+(?:shots?\s+on\s+target|shots?|assists?|goals?|saves?|tackles?|cards?)(?=$|\W)/i,
  /\b(?:assists?|rebounds?|points?|blocks?|steals?|threes?|3-pointers?)\s+(?:o\s*\/\s*u|over\s*\/\s*under)\b/i,
  /\bplayer\s+(?:assists?|rebounds?|points?|blocks?|steals?)\b/i,
  /\b(?:over|under)\s+\d+(?:\.\d+)?\s+(?:assists?|rebounds?|points?|blocks?|steals?)\b/i,
  /\b(?:first|second) half\b/i,
  /\bhalftime\b/i,
  /\bmap\s+\d+\b/i,
  /\bgame\s+\d+\s*:/i,
  /\bbest of\s+\d+\b/i,
  /\b(?:team|player|club|side)\b.{0,80}\bto\s+win\s+\d+\s*-\s*\d+\b/i,
  /\b[A-Za-z][A-Za-z0-9 .'\-]{2,50}\s+to\s+win\s+\d+\s*-\s*\d+\b/i,
  /\bteam\s+from\s+(?:lck|lpl|lec|lcs)\b.{0,80}\bwin\b/i,
  /\b[A-Za-z][A-Za-z .'\-]{2,40}\s+vs\.?\s+[A-Za-z][A-Za-z .'\-]{2,40}\b/i,
] as const;

export const SPORTS_WIN_ON_DATE_PATTERN =
  /\b(?:will\s+)?[A-Za-z][A-Za-z .'\-]{2,40}\s+win(?:s)?\s+on\s+(?:\d{4}-\d{2}-\d{2}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?)\b/i;

export const SPORTS_WIN_ON_GUARD_KEYWORDS = [
  "award",
  "awards",
  "candidate",
  "coalition",
  "congress",
  "election",
  "emmy",
  "governor",
  "grammy",
  "mayor",
  "minister",
  "oscar",
  "parliament",
  "party",
  "president",
  "presidential",
  "primary",
  "referendum",
  "seat",
  "senate",
  "vote",
  "voter",
] as const;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesWholeWordKeyword(text: string, keyword: string) {
  return new RegExp(`(^|\\W)${escapeRegExp(keyword)}(?=$|\\W)`, "i").test(text);
}

export function isLikelySportsWinOnText(text: string) {
  return (
    SPORTS_WIN_ON_DATE_PATTERN.test(text) &&
    !SPORTS_WIN_ON_GUARD_KEYWORDS.some((keyword) =>
      matchesWholeWordKeyword(text, keyword),
    )
  );
}

export const MARKET_PREDICTION_PATTERNS = [
  /\blargest company in the world by market cap\b/i,
  /\blargest company by market cap\b/i,
] as const;

export const BULLPEN_SCAN_FILTER_DETAILS: Record<
  BullpenScanFilterDetailId,
  BullpenScanFilterDetail
> = {
  excludeSports: {
    id: "excludeSports",
    label: "Exclude sports",
    description:
      "Remove sports leagues, teams, games, tournaments, halftime/score props, and esports match markets, including tennis tours and Wimbledon-style questions.",
    dialogEyebrow: "Sports exclusion",
    title: "How the sports filter excludes markets",
    matcherScope:
      "Search text = question + category/tags/event category + slug + outcome labels, normalized to lowercase and matched on whole words plus sports phrase patterns.",
    algorithmSteps: [
      "Build a normalized search string from the market question, category, slug, outcome labels, and supported nested event/category metadata.",
      "Run whole-word keyword checks across that search string.",
      "Run sports-market phrase checks for scoreboard-style props, match-up titles, and esports map/best-of patterns.",
      "Exclude the market as soon as any sports keyword or sports phrase matches.",
    ],
    keywordGroups: SPORTS_KEYWORD_GROUPS.map((group) => group.join(", ")),
    patternRules: [
      "both teams to score, exact score, leading/draw at halftime, penalty shootout, extra time",
      "player-prop thresholds such as 1+ assists, 2+ shots, 1+ goals, and shots on target",
      "team/country win on <date> phrasing when no election-style keywords are present",
      "Team A vs Team B / Team A vs. Team B question titles",
      "first half / second half",
      "map <number>",
      "best of <number>",
    ],
    excludedEventExamples: [
      "League, team, match, tournament, and winner markets.",
      "Player-prop thresholds such as 1+ assists, 2+ shots, 1+ goals, and shots on target markets.",
      'Winner phrasing such as "Will Norway win on 2026-06-26?" when the market text does not look like politics or awards.',
      "Halftime, both-teams-to-score, and exact-score markets such as Argentina vs. Egypt match props.",
      "Tennis questions such as Wimbledon, ATP, WTA, and Grand Slam events.",
      "Esports and global competition markets such as Dota, CS2, map markets, World Cup, or Champions League.",
    ],
  },
  excludeWeather: {
    id: "excludeWeather",
    label: "Exclude weather",
    description:
      "Remove temperature, storm, rainfall, hurricane, and climate-style markets.",
    dialogEyebrow: "Weather exclusion",
    title: "How the weather filter excludes markets",
    matcherScope:
      "Search text = question + category + slug + outcome labels, normalized to lowercase and matched on whole words.",
    algorithmSteps: [
      "Build the normalized search string from the same market text fields.",
      "Run whole-word keyword checks for weather and climate terms.",
      "Exclude the market when any weather keyword matches.",
    ],
    keywordGroups: WEATHER_KEYWORD_GROUPS.map((group) => group.join(", ")),
    excludedEventExamples: [
      "Temperature, rainfall, storm, hurricane, and tornado markets.",
      "Forecast and climate-style questions.",
    ],
  },
  excludeMarketPredictions: {
    id: "excludeMarketPredictions",
    label: "Exclude market predictions",
    description:
      "Remove finance, macro, stocks, commodities, crypto-price, and largest-company-by-market-cap questions.",
    dialogEyebrow: "Market prediction exclusion",
    title: "How the market prediction filter excludes markets",
    matcherScope:
      "Category matches use whole-word checks on the category field. Question matches use normalized search text built from question + category + slug + outcome labels.",
    algorithmSteps: [
      "Exclude the market if the category contains a finance or macro keyword such as finance, business, markets, crypto, economy, stocks, commodities, or forex.",
      "Exclude the market if the normalized search text contains asset-price or macro keywords such as bitcoin, share price, nasdaq, gold, inflation, interest rate, or ETF terms.",
      "Exclude the market if the normalized search text matches the market-cap leadership patterns below.",
    ],
    keywordGroups: [
      ...MARKET_CATEGORY_KEYWORD_GROUPS.map((group) => group.join(", ")),
      ...MARKET_QUESTION_KEYWORD_GROUPS.map((group) => group.join(", ")),
    ],
    patternRules: [
      "largest company in the world by market cap",
      "largest company by market cap",
    ],
    excludedEventExamples: [
      'Questions of the form "Will Company X be the largest company in the world by market cap on <date>?"',
      'Questions of the form "Will any other company be the largest company in the world by market cap on <date>?"',
    ],
  },
  excludeTweetCountQuestions: {
    id: "excludeTweetCountQuestions",
    label: "Exclude tweet counts",
    description:
      "Remove questions asking how many tweets or social posts someone will make.",
    dialogEyebrow: "Social-count exclusion",
    title: "How the tweet-count filter excludes markets",
    matcherScope:
      "Search text = question + category + slug + outcome labels, normalized to lowercase before keyword and regex checks.",
    algorithmSteps: [
      "Require both a social-post keyword match and a quantitative count-pattern match.",
      "Keep broad social-media questions unless they explicitly ask for a count, threshold, range, or number of posts.",
      "Exclude the market only when both the keyword set and one of the pattern rules below match.",
    ],
    keywordGroups: SOCIAL_POST_COUNT_KEYWORD_GROUPS.map((group) =>
      group.join(", "),
    ),
    patternRules: [
      "how many tweets|posts|truths",
      "number of tweets|posts|truths",
      "at least|at most|more than|less than|over|under|between <number> ... tweets|posts|truths",
      "<number>-<number> tweets|posts|truths",
      "<number>+ tweets|posts|truths",
    ],
    excludedEventExamples: [
      "How many tweets will someone post this week?",
      "Will a person make at least 10 Truth Social posts this month?",
    ],
  },
  excludeReleasedByEvents: {
    id: "excludeReleasedByEvents",
    label: "Exclude release-by events",
    description:
      'Remove deadline markets asking whether something will be released by a date.',
    dialogEyebrow: "Release-by exclusion",
    title: "How the release-by filter excludes markets",
    matcherScope:
      'Search text = question + category + slug + outcome labels, normalized to lowercase and matched for the phrase "released by".',
    algorithmSteps: [
      "Build the normalized search string from the same market text fields.",
      'Run an exact phrase check for "released by" so deadline-release markets are removed.',
      "Exclude the market when the release-by phrase appears anywhere in the market text.",
    ],
    keywordGroups: [RELEASED_BY_EVENT_KEYWORDS.join(", ")],
    excludedEventExamples: [
      'Questions such as "GPT-5.6 released by July 7, 2026?"',
      'Product, model, movie, album, game, or software release deadline markets that use "released by" phrasing.',
    ],
  },
  onlyBinaryYesNo: {
    id: "onlyBinaryYesNo",
    label: "Only Yes / No",
    description:
      "Keep only binary markets that resolve between a Yes and No outcome.",
    dialogEyebrow: "Binary outcome rule",
    title: "How the Yes / No-only rule keeps markets",
    matcherScope:
      "Outcome labels are normalized to lowercase and deduplicated before the binary check runs.",
    algorithmSteps: [
      "If explicit outcome labels exist, keep the market only when there are exactly two unique labels and they are yes and no.",
      "If outcome labels are missing, keep the market only when both Yes odds and No odds are present.",
      "Exclude every other multi-outcome, unclear, or non-binary market shape.",
    ],
    excludedEventExamples: [
      "Ranges such as 0-10 / 11-20 / 21+ are excluded.",
      "Markets with more than two outcomes are excluded.",
      "Markets without a clear Yes and No structure are excluded.",
    ],
  },
};
