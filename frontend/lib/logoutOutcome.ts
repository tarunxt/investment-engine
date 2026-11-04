export type LogoutResponse = { message?: string; session_revocation?: "confirmed" };
export type LogoutOutcome = {
  serverRevocation: "confirmed" | "unconfirmed";
  authJsSignOut: "completed" | "failed";
  privateCleanup: "completed" | "failed";
};

// UI recovery deadline only; this does not change a credential/session lifetime
// or prove cancellation of an SDK/network request after the deadline.
export const LOGOUT_STEP_TIMEOUT_MS = 5_000;

type LogoutTimers = {
  set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
};

function boundedStep<T>(operation: () => Promise<T>, timers: LogoutTimers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = timers.set(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Sign-out response was not confirmed before the UI deadline"));
    }, LOGOUT_STEP_TIMEOUT_MS);
    Promise.resolve().then(operation).then(
      (value) => {
        if (settled) return;
        settled = true;
        timers.clear(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        timers.clear(timer);
        reject(error);
      },
    );
  });
}

export async function performLogout(steps: {
  revoke: () => Promise<unknown>;
  signOut: () => Promise<unknown>;
  cleanup: () => void;
  previousServerRevocation?: LogoutOutcome["serverRevocation"];
  onServerConfirmed?: () => void;
  timers?: LogoutTimers;
}): Promise<LogoutOutcome> {
  const outcome: LogoutOutcome = {
    serverRevocation: steps.previousServerRevocation === "confirmed" ? "confirmed" : "unconfirmed",
    authJsSignOut: "failed",
    privateCleanup: "failed",
  };
  // Purge private state synchronously, before either asynchronous request.
  try {
    steps.cleanup();
    outcome.privateCleanup = "completed";
  } catch {
    // Still attempt sign-out, while reporting local cleanup as incomplete.
  }
  // Native browser timers require their Window receiver. Calling a borrowed
  // setTimeout as timers.set(...) otherwise throws before logout dispatch.
  const timers = steps.timers || {
    set: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
    clear: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
  };
  if (outcome.serverRevocation !== "confirmed") {
    try {
      const reply = await boundedStep(steps.revoke, timers);
      if (reply && typeof reply === "object" &&
          (reply as LogoutResponse).session_revocation === "confirmed") {
        outcome.serverRevocation = "confirmed";
        // Retain acknowledged evidence immediately, even if local sign-out hangs.
        steps.onServerConfirmed?.();
      }
    } catch {
      // A deadline, 401 or lost reply proves neither revocation nor its absence.
    }
  }
  try {
    await boundedStep(steps.signOut, timers);
    // SDK completion is not independent observation of HttpOnly-cookie removal.
    outcome.authJsSignOut = "completed";
  } catch {
    // Return a finite retry state. Late promise outcomes cannot change this result.
  }
  return outcome;
}

export function logoutRedirect(outcome: LogoutOutcome): string | null {
  if (outcome.authJsSignOut !== "completed" || outcome.privateCleanup !== "completed") return null;
  return outcome.serverRevocation === "confirmed"
    ? "/login"
    : "/login?logout=server-revocation-unconfirmed";
}

export function logoutWarning(value: string | null) {
  // The query is only an untrusted warning, never evidence of server success.
  return value === "server-revocation-unconfirmed"
    ? "Local sign-out was requested and private data was cleared in this tab. Server session revocation could not be confirmed."
    : null;
}
