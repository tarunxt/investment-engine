export type ThresholdPersistence = "loading" | "saved" | "saving" | "local_only" | "unconfirmed" | "error";
export function thresholdSignature(zerodha: number, indmoney: number) {
  return JSON.stringify([zerodha, indmoney]);
}
export function shouldSaveThresholds(loaded: boolean, writable: boolean, saved: string | null, current: string, pending = false) {
  return loaded && writable && saved !== null && (saved !== current || pending);
}
