/** Bound the view's wait without truncating or caching a partial history. */
export async function withFinalActionablesReadDeadline<T>(read: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Final actionables history did not finish loading in time. Please try again.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
