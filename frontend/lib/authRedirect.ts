const DEFAULT_AUTH_REDIRECT = "/console/dashboard";
const LOCAL_ORIGIN = "http://localhost";
const MAX_REDIRECT_LENGTH = 4096;
const MAX_SANITIZE_PASSES = 4;

export const isClientAuthBypassed =
  process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
  process.env.NODE_ENV === "development";

const AUTH_ROUTE_PREFIXES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
] as const;

function isAuthRoute(path: string) {
  return AUTH_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function buildCurrentPath(pathname: string, search: string | null | undefined) {
  const normalizedPath = pathname?.trim() || DEFAULT_AUTH_REDIRECT;
  const params = new URLSearchParams(search || "");
  params.delete("redirectTo");
  const query = params.toString();
  return query ? `${normalizedPath}?${query}` : normalizedPath;
}

function sanitizeInternalPath(path: string) {
  let current = path;

  for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass += 1) {
    const url = new URL(current, LOCAL_ORIGIN);
    const pathname = url.pathname?.trim() || DEFAULT_AUTH_REDIRECT;

    if (!pathname.startsWith("/") || pathname.startsWith("//")) {
      return DEFAULT_AUTH_REDIRECT;
    }

    if (isAuthRoute(pathname)) {
      return DEFAULT_AUTH_REDIRECT;
    }

    url.searchParams.delete("redirectTo");
    const query = url.searchParams.toString();
    const next = `${pathname}${query ? `?${query}` : ""}${url.hash || ""}`;
    if (next === current) {
      return next;
    }
    current = next;
  }

  return current;
}

export function resolveAuthRedirectTarget(path: string | null | undefined) {
  const trimmed = path?.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_REDIRECT_LENGTH ||
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//")
  ) {
    return DEFAULT_AUTH_REDIRECT;
  }
  try {
    return sanitizeInternalPath(trimmed);
  } catch {
    return DEFAULT_AUTH_REDIRECT;
  }
}

export function buildLoginRedirectHref(
  pathname: string,
  search: string | null | undefined,
) {
  const redirectTo = resolveAuthRedirectTarget(buildCurrentPath(pathname, search));
  const params = new URLSearchParams({ redirectTo });
  return `/login?${params.toString()}`;
}

export function stripRedirectToFromCurrentUrl(
  pathname: string,
  search: string | null | undefined,
) {
  return resolveAuthRedirectTarget(buildCurrentPath(pathname, search));
}
