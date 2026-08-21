export type InternetAccessMode =
  | "always_enabled"
  | "tool_auto"
  | "conditional"
  | "none";

export type ProviderInternetAccess = {
  mode: InternetAccessMode;
  label: string;
  force_token?: string | null;
  caveat?: string | null;
};

type ProviderLike = {
  name: string;
  models: string[];
  internet_access?: ProviderInternetAccess | null;
};

const FALLBACK_PROVIDER_INTERNET_ACCESS: Record<string, ProviderInternetAccess> = {
  openai: {
    mode: "conditional",
    label: "Search only if forced",
    force_token: "[enable_web_search]",
    caveat:
      "Uses live web tools only when the prompt asks for current context or explicitly includes [enable_web_search].",
  },
  gemini: {
    mode: "always_enabled",
    label: "Search attached",
    caveat:
      "Google Search grounding is attached by default for normal runs. Repair prompts disable search to keep output formatting stable.",
  },
  deepseek: {
    mode: "tool_auto",
    label: "Can search, not guaranteed",
    caveat:
      "The web_search tool is available with automatic tool choice. Actual usage has to be confirmed from the saved run metadata.",
  },
  anthropic: {
    mode: "none",
    label: "No model-side search",
    caveat:
      "The current Anthropic adapter sends plain API calls without any live web or search tool.",
  },
};

function getModelKey(providerName: string, model: string) {
  return `${providerName}::${model}`;
}

export function getResolvedProviderInternetAccess(
  providerName: string,
  internetAccess?: ProviderInternetAccess | null,
): ProviderInternetAccess {
  const fallback =
    FALLBACK_PROVIDER_INTERNET_ACCESS[providerName.trim().toLowerCase()] ||
    FALLBACK_PROVIDER_INTERNET_ACCESS.anthropic;

  if (!internetAccess) {
    return { ...fallback };
  }

  return {
    ...fallback,
    ...internetAccess,
    force_token: internetAccess.force_token ?? fallback.force_token ?? null,
    caveat: internetAccess.caveat ?? fallback.caveat ?? null,
  };
}

export function isWebCapableInternetAccess(
  internetAccess: ProviderInternetAccess | null | undefined,
) {
  return (internetAccess?.mode || "none") !== "none";
}

export function getInternetAccessBadgeText(
  internetAccess: ProviderInternetAccess | null | undefined,
) {
  switch (internetAccess?.mode) {
    case "always_enabled":
      return "Search attached";
    case "tool_auto":
      return "Can search, not guaranteed";
    case "conditional":
      return "Search only if forced";
    default:
      return "No model-side search";
  }
}

export function getInternetAccessTooltipText(
  internetAccess: ProviderInternetAccess | null | undefined,
) {
  if (!internetAccess) {
    return "No live web metadata is available for this provider.";
  }

  const parts = [internetAccess.caveat || internetAccess.label];
  if (internetAccess.force_token) {
    parts.push(`Force token: ${internetAccess.force_token}`);
  }
  return parts.join(" ");
}

export function getWebCapableModelKeys(providers: ProviderLike[]) {
  return providers.flatMap((provider) => {
    const internetAccess = getResolvedProviderInternetAccess(
      provider.name,
      provider.internet_access,
    );
    if (!isWebCapableInternetAccess(internetAccess)) {
      return [];
    }
    return provider.models.map((model) => getModelKey(provider.name, model));
  });
}

export function countSelectedWebCapableModels(
  providers: ProviderLike[],
  selectedKeys: Iterable<string>,
) {
  const selectedSet = new Set(selectedKeys);
  const webCapableKeys = new Set(getWebCapableModelKeys(providers));
  let count = 0;

  selectedSet.forEach((key) => {
    if (webCapableKeys.has(key)) {
      count += 1;
    }
  });

  return count;
}
