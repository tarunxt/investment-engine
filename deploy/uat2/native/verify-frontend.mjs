import { readFile, stat } from "node:fs/promises";
import path from "node:path";
const [root, source] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(path.join(root, "deployment-manifest.json"), "utf8"));
if (manifest.build_sha !== source || manifest.platform !== "linux" || manifest.arch !== "x64" || manifest.node_major !== 22) throw Error("Native frontend platform/source mismatch");
for (const file of ["server.js", ".next/BUILD_ID", ".next/server/app-paths-manifest.json"]) await stat(path.join(root, file));
const routes = JSON.parse(await readFile(path.join(root, ".next/server/app-paths-manifest.json"), "utf8"));
if (!Object.keys(routes).some(route => route.includes("/console/uat2/"))) throw Error("Actual UAT2 walkthrough missing");
console.log(`Native frontend source ${source} validated`);
