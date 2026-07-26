const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";
const INSECURE_SESSION_COOKIE = "authjs.session-token";

function containsCookieFamily(cookieNames: readonly string[], baseName: string) {
  return cookieNames.some(
    (name) => name === baseName || name.startsWith(`${baseName}.`),
  );
}

function configuredAuthUsesHttps(configuredAuthUrl: string | undefined) {
  if (!configuredAuthUrl) return null;

  try {
    return new URL(configuredAuthUrl).protocol === "https:";
  } catch {
    return null;
  }
}

export function resolveSessionCookieSecurity(input: {
  cookieNames: readonly string[];
  forwardedProtocol?: string | null;
  requestProtocol: string;
  configuredAuthUrl?: string;
}) {
  // The cookie that is actually present is authoritative. This also handles
  // Auth.js's numbered cookie chunks, which are used for larger JWT sessions.
  if (containsCookieFamily(input.cookieNames, SECURE_SESSION_COOKIE)) {
    return true;
  }
  if (containsCookieFamily(input.cookieNames, INSECURE_SESSION_COOKIE)) {
    return false;
  }

  const forwardedProtocol = input.forwardedProtocol
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProtocol === "https") return true;
  if (forwardedProtocol === "http") return false;

  const configuredSecurity = configuredAuthUsesHttps(input.configuredAuthUrl);
  if (configuredSecurity !== null) return configuredSecurity;

  return input.requestProtocol === "https:";
}
