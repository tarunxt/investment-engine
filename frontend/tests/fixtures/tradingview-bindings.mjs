// The isolated TSX test harnesses strip imports. Supply their real chart renderers.
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const frontend = new URL('../../',import.meta.url).pathname;
const {outputFiles} = await build({
  absWorkingDir: frontend, stdin: {contents: 'export * from "./lib/tradingview"; export * from "./components/shared/TradingViewSymbolLink"; export * from "./lib/remarkTradingView";', resolveDir: frontend},
  bundle: true, platform:'node', format:'cjs', write:false, external:['react','react/jsx-runtime'], jsx:'automatic',
});
const module = {exports:{}};
new Function('module','exports','require',outputFiles[0].text)(module,module.exports,createRequire(import.meta.url));
export const chartBindings = module.exports;
