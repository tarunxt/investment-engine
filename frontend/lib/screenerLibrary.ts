import { URLs } from "./urls";

export const screenerPath = "/console/zerodha/screener-library";
export const strategies = { og: "OG Strategy", bfs: "Bottom Fishing" } as const;
export type Strategy = keyof typeof strategies;
export type Screener = {
  id: string;
  name: string;
  summary: string;
  query?: string;
  latest_results?: boolean;
};
export type Library = {
  version: number;
  screeners: Screener[];
  assigned: Record<Strategy, string[]>;
  fields: string[];
};
export const nativeScreeners = { og: "swing", bfs: "bottom" };
export const screenerApi = () => URLs.runs.list() + "/scorecards/india/screeners";
export function screenerHref(strategy: Strategy, screen = "") {
  return screenerPath + (screen ? "/" + encodeURIComponent(screen) : "") + "?strategy=" + strategy;
}
export function nativeScreen(id: string) {
  if (id === "swing") return URLs.routes.console.zerodhaSwingTrade();
  if (id === "bottom") return "/console/zerodha/bottom-fishing/screen";
  return null;
}
