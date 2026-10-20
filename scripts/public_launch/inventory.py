"""Source-only baseline inventory. Never import the app or connect to services.

Classification is the launch policy target; extracted guards are observations,
not proof of authorization. Keep source evidence and unresolved cases visible.
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path("docs/public-launch/entrypoints.json")
HTTP = {"get", "post", "put", "patch", "delete", "head", "options", "websocket", "api_route"}
SHARED = {"sports_rankings", "ai_providers", "fx_rates"}
SIDE_EFFECTS = {
    "auth": "user/session DB; transactional email; Google identity verification",
    "jobs": "job DB; Redis; queued AI; export destinations",
    "runs": "run DB; Redis; queued AI; notifications and exports",
    "zerodha": "private broker data; Kite authorization/order I/O; DB; queues",
    "indmoney_us": "private import/snapshot DB; analysis/notifications",
    "polymarket": "singleton wallet/runtime; broker/process/network/financial I/O possible",
    "polymarket_auto_live": "broker orders; wallet/runtime; DB; queues; exports",
    "polymarket_direct": "broker orders; singleton wallet/runtime; DB",
    "bullpen008": "broker/runtime; AI; DB; queues; notifications",
    "bullpen_trade_analysis": "private trade DB; AI; queues",
    "google_sheets": "Google OAuth and external spreadsheet writes",
    "mails": "private mail history; external email delivery",
    "dashboard": "private portfolio DB; broker snapshots; platform cost reads",
    "cost_drivers": "platform billing/configuration and provider reads",
    "api_usage": "usage ledger; platform/private cost data",
    "sports_rankings": "shared catalogue DB; provider refresh/AI on mutations",
    "recommendation_audit": "private recommendation DB; optional provider/AI calls",
    "prompts": "prompt DB; shared/system and user-owned records",
}


def expr(node):
    return ast.unparse(node) if node is not None else ""


def literal(node, default=""):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        return default


def module_for(path):
    bits = path.parts
    return bits[bits.index("domains") + 1] if "domains" in bits else (
        "frontend" if bits[0] == "frontend" else "platform")


def classify(module, kind, capability, text, method=""):
    if any(guard in text for guard in ("require_admin", "require_singleton_bullpen_runtime_access", "require_operator_", "requireBullpenOperator")):
        return "administrator-only"
    if module in {"polymarket", "polymarket_direct", "polymarket_auto_live", "bullpen008", "bullpen_trade_analysis", "bullpen_run_audit", "trading_bots", "cost_drivers"}:
        return "administrator-only"
    if kind == "worker" and re.search(r"\b(user_id|owner_id)\b", text):
        return "owner-private"
    if kind in {"worker", "scheduler", "background", "lifecycle"}:
        return "shared-read" if module in SHARED and "refresh" not in capability else "administrator-only"
    if module == "health" or capability == "root":
        return "public"
    if module == "auth" and not any(x in text for x in ("Depends(get_current_user)", "Depends(require_")):
        return "public"
    if module in SHARED:
        return "shared-read" if method in {"GET", "HEAD"} else "administrator-only"
    if kind == "page" and not capability.startswith("/console"):
        return "public"
    if kind == "frontend" and ("nextauth" in capability or "runtime-fingerprint" in capability):
        return "public"
    return "owner-private"


def scan(root=ROOT):
    rows, files, unresolved = [], {}, []
    trees = {}
    for file in sorted((root / "backend/app").rglob("*.py")):
        rel = file.relative_to(root)
        source = file.read_text()
        files[str(rel)] = hashlib.sha256(source.encode()).hexdigest()
        trees[rel] = (ast.parse(source), source)
    # Follow the actual import/include graph instead of assuming every router is mounted.
    mounts = {"app.main": ""}
    changed = True
    while changed:
        changed = False
        for rel, (tree, _) in trees.items():
            mod = ".".join(rel.with_suffix("").parts[1:])
            if mod not in mounts:
                continue
            imports = {}
            for n in tree.body:
                if isinstance(n, ast.ImportFrom) and n.module:
                    for a in n.names:
                        imports[a.asname or a.name] = n.module
            for n in ast.walk(tree):
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "include_router":
                    target = imports.get(expr(n.args[0])) if n.args else None
                    prefix = next((literal(k.value) for k in n.keywords if k.arg == "prefix"), "")
                    parent_prefix = ""
                    for assignment in tree.body:
                        if isinstance(assignment, ast.Assign) and any(expr(t) == expr(n.func.value) for t in assignment.targets):
                            if isinstance(assignment.value, ast.Call):
                                parent_prefix = next((literal(k.value) for k in assignment.value.keywords if k.arg == "prefix"), "")
                    if target and target not in mounts:
                        mounts[target] = mounts[mod] + parent_prefix + prefix
                        changed = True
                    elif not target:
                        unresolved.append(f"{rel}:{n.lineno}: unresolved include_router")
    for rel, (tree, source) in trees.items():
        module = module_for(rel)
        py_module = ".".join(rel.with_suffix("").parts[1:])
        prefixes, router_guards = {}, {}
        for n in ast.walk(tree):
            if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and expr(n.value.func).endswith("APIRouter"):
                for target in n.targets:
                    prefixes[expr(target)] = next((literal(k.value) for k in n.value.keywords if k.arg == "prefix"), "")
                    router_guards[expr(target)] = [expr(k.value) for k in n.value.keywords if k.arg == "dependencies"]

        def add(kind, node, capability, method="", route="", guards=None, registration=""):
            text = ast.get_source_segment(source, node) or ""
            calls = sorted({expr(c.func) for c in ast.walk(node) if isinstance(c, ast.Call)})
            deps = sorted({expr(c) for c in ast.walk(node) if isinstance(c, ast.Call)
                           and expr(c.func) in {"Depends", "Security"}})
            observed = sorted(set(deps + (guards or []) + [c for c in calls if any(
                s in c.lower() for s in ("require", "authorize", "recovery", "permission", "user_id_from_ws", "ensure_owner"))]))
            owner = sorted({expr(n) for n in ast.walk(node) if isinstance(n, ast.Attribute)
                            and n.attr in {"user_id", "owner_id", "id"} and any(
                                s in expr(n.value) for s in ("user", "owner", "current"))})
            arguments = [a.arg for a in node.args.args + node.args.kwonlyargs] if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else []
            owner += [a + " (input; authority unverified)" for a in arguments if a in {"user_id", "owner_id", "account_id", "token"}]
            rows.append(dict(kind=kind, source=f"{rel}:{node.lineno}", module=module,
                             capability=capability, method=method, route=route,
                             classification=classify(module, kind, capability, text, method),
                             owner_source=owner or ["not established in local function; inspect callers/repository"],
                             observed_guards=observed or ["none found locally; not proof of public access"],
                             side_effects=SIDE_EFFECTS.get(module, "inspect calls; DB/network/filesystem effects possible"),
                             calls=calls, registration=registration))
        for n in ast.walk(tree):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for dec in n.decorator_list:
                    call = dec if isinstance(dec, ast.Call) else None
                    func = call.func if call else dec
                    name = expr(func)
                    attr = name.rsplit(".", 1)[-1]
                    if attr in HTTP:
                        if not call or not call.args or not isinstance(call.args[0], ast.Constant):
                            unresolved.append(f"{rel}:{dec.lineno}: dynamic route {name}")
                            continue
                        router = expr(func.value) if isinstance(func, ast.Attribute) else ""
                        route = mounts.get(py_module, "") + prefixes.get(router, "") + str(literal(call.args[0]))
                        methods = next((literal(k.value, []) for k in call.keywords if k.arg == "methods"), [attr.upper()])
                        for method in methods:
                            add("websocket" if attr == "websocket" else "http", n, n.name, method, route,
                                router_guards.get(router, []) + [expr(dec)], "mounted" if py_module in mounts else "unmounted")
                    elif attr in {"task", "shared_task"}:
                        add("worker", n, n.name, registration=expr(dec))
                    elif attr in {"connect", "on_event"} or name == "asynccontextmanager":
                        add("lifecycle", n, n.name, registration=expr(dec))
                if re.search(r"(^|_)(export|exports|xlsx|excel|csv|pdf|spreadsheet|sheets|download)(_|$)", n.name) or n.name in {"write_sheet", "append_sheet", "create_spreadsheet"}:
                    add("export", n, n.name)
            elif isinstance(n, ast.Dict):
                keys = {literal(k): v for k, v in zip(n.keys, n.values) if k is not None and isinstance(literal(k), str)}
                if "task" in keys and "schedule" in keys:
                    add("scheduler", n, str(literal(keys["task"], expr(keys["task"]))), registration=expr(n))
            elif isinstance(n, ast.Call):
                name = expr(n.func)
                if name.endswith((".add_api_route", ".add_websocket_route", ".mount", ".add_route")):
                    unresolved.append(f"{rel}:{n.lineno}: imperative registration {name}")
                if name.endswith((".create_task", ".ensure_future", ".add_task", ".Thread", ".Timer")) or name in {"Thread", "Timer"}:
                    add("background", n, expr(n))
    # Next App Router route handlers, pages, proxy and NextConfig rewrites.
    for file in sorted((root / "frontend").rglob("*")):
        if not file.is_file() or any(p in {"node_modules", ".next", ".runtime"} for p in file.parts):
            continue
        if file.name not in {"route.ts", "route.js", "page.tsx", "page.jsx", "proxy.ts", "next.config.ts"}:
            continue
        rel = file.relative_to(root)
        source = file.read_text()
        files[str(rel)] = hashlib.sha256(source.encode()).hexdigest()
        route = "/" + "/".join(p for p in rel.parts[2:-1] if not (p.startswith("(") and p.endswith(")")))
        kind = "page" if file.name.startswith("page.") else "frontend"
        methods = re.findall(r"export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b", source)
        aliases = re.findall(r"\bas\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b", source)
        for group in re.findall(r"export\s+const\s*\{([^}]+)\}\s*=", source):
            aliases.extend(re.findall(r"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b", group))
        for method in sorted(set(methods + aliases)) or ["GET" if kind == "page" else "DISPATCH"]:
            guards = sorted(set(re.findall(r"\b(?:auth|getToken|require\w+|createBackendSessionContext|rotateBackendTokens|resolve\w*Session)\s*\(", source)))
            rows.append(dict(kind=kind, source=f"{rel}:1", module="frontend", capability=route if file.name not in {"proxy.ts", "next.config.ts"} else file.name,
                             method=method, route=route, classification=classify("frontend", kind, route, source, method),
                             owner_source=["Auth.js session/backend token where enforced; inspect server helper/proxy"],
                             observed_guards=guards or ["none found locally; inspect frontend/proxy.ts and layouts"],
                             side_effects="backend proxy or server rendering; see corresponding backend entry; exports may return files",
                             calls=[], registration="App Router convention" if file.name not in {"proxy.ts", "next.config.ts"} else "framework ingress"))
    # Framework-created FastAPI documentation routes.
    main_tree = trees[Path("backend/app/main.py")][0]
    framework_line = next(n.lineno for n in ast.walk(main_tree)
                          if isinstance(n, ast.Call) and expr(n.func) == "FastAPI")
    for route in ("/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"):
        rows.append(dict(kind="http", source=f"backend/app/main.py:{framework_line}", module="platform", capability="FastAPI built-in docs",
                         method="GET", route=route, classification="public", owner_source=["none"],
                         observed_guards=["FastAPI defaults; global recovery middleware may deny"], side_effects="schema/documentation only",
                         calls=[], registration="framework default"))
    # Execute only the deliberately source-only canonical classifier. It has no
    # application imports, environment reads, database or network side effects.
    import runpy
    coverage=runpy.run_path(str(root/'backend/app/domains/modules/coverage.py'))
    for row in rows:
        if row['kind']=='http' and row['source'].startswith('backend/app/domains/'):
            binding=coverage['classify_route'](row['module'],row['capability'],row['route'],{row['method']})
            row['module_lifecycle_gate']='core/safety; existing auth/owner/role checks' if binding is None else ' / '.join(binding)+' via modules.transports.install_route_policy'
        elif row['kind'] in {'worker','scheduler'}:
            row['module_lifecycle_gate']='RecoveryCelery producer/run + persisted binding/current policy; explicit safety classification in modules.tasks; UAT2 fake worker has its own stored Job guard'
        elif row['kind'] in {'background','export','websocket','lifecycle'}:
            row['module_lifecycle_gate']='originating route/task policy and direct adapter/current-stream guards; see STAGE07_COVERAGE.md for transitive audit and closed legacy paths'
        else:row['module_lifecycle_gate']='framework/core or frontend proxy; backend remains authoritative'
    # Avoid duplicate unresolved messages from fixed-point traversal.
    rows.sort(key=lambda r: (r["source"], r["kind"], r["method"], r["route"], r["capability"]))
    return dict(schema_version=1, baseline_sha="0c6e61e524c7a87c7b9ea79342f17b14a45e97a1",
                mount_scope="app.main; restricted app.uat2.main composition reviewed separately in UAT2_ENTRYPOINT_MATRIX.md",
                classification_semantics="intended launch access; observed guards do not prove enforcement",
                counts=dict(sorted(Counter(r["kind"] for r in rows).items())),
                unresolved=sorted(set(unresolved)), source_sha256=files, entries=rows)


def render(data):
    text = ["# Route, worker, scheduler and export matrix", "",
            "Generated by scripts/public_launch/inventory.py. Read DECISIONS.md and RELEASE_GATES.md first.",
            "Classification is the intended launch access class, not a claim that it is enforced.",
            "Owner sources/guards are local static evidence; transitive calls require review. All export helpers are included conservatively.",
            "Backend source hashes and full call lists are in entrypoints.json. Unmounted routers remain visible.",
            "Mount labels describe app.main; see UAT2_ENTRYPOINT_MATRIX.md for the restricted app.uat2.main composition and route filters.",
            "Workers with owner inputs require owner-private authorization at enqueue/execution; administrator-only background entries describe internal dispatch authority, not permission to read every tenant.",
            "Shared-read entries never authorize unscoped private holdings, prompts, costs or exports. Module-level possible effects are conservative and need transitive review.",
            "Framework handlers/pages, background dispatch sites and Beat entries are included; dynamic external registrations cannot be certified from source.",
            "", "Counts: " + json.dumps(data["counts"], sort_keys=True), "",
            "Unresolved registrations: " + (", ".join(data["unresolved"]) or "none found by scanner"), "",
            "| Kind / module | Method / path or capability | Launch class | Owner source | Observed guards | Possible external effects | Module lifecycle gate | Source / registration |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    def clean(value):
        return str(value).replace("|", "\\|").replace("\n", " ").replace("<", "&lt;").replace(">", "&gt;")
    for row in data["entries"]:
        values = [row["kind"] + " / " + row["module"], row["method"] + " " + (row["route"] or row["capability"]),
                  row["classification"], "; ".join(row["owner_source"]), "; ".join(row["observed_guards"]),
                  row["side_effects"], row["module_lifecycle_gate"], row["source"] + " / " + row["registration"]]
        text.append("| " + " | ".join(clean(v) for v in values) + " |")
    return "\n".join(text) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    data = scan()
    targets = {OUTPUT: json.dumps(data, indent=2, sort_keys=True) + "\n",
               Path("docs/public-launch/ROUTE_MATRIX.md"): render(data)}
    if args.check:
        stale = [str(p) for p, content in targets.items() if not (ROOT / p).exists() or (ROOT / p).read_text() != content]
        if stale or data["unresolved"]:
            raise SystemExit("Inventory incomplete/stale: " + repr(stale + data["unresolved"]))
    else:
        for path, content in targets.items():
            (ROOT / path).parent.mkdir(parents=True, exist_ok=True)
            (ROOT / path).write_text(content)
    print(json.dumps({"counts": data["counts"], "unresolved": data["unresolved"]}, sort_keys=True))


if __name__ == "__main__":
    main()
