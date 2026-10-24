# Frontend dependency security repair (local)

Reviewed 2026-10-23 21:45–21:56 UTC. The inherited lockfile audit reported one critical Next.js package finding (three advisories) and one high transitive Zod finding. This finding applies to the earlier local composition build too; its passing build did not qualify it for deployment.

This repair pins Next.js and eslint-config-next to 16.4.1 and overrides transitive Zod to 4.6.6. The existing unrelated fastq version is preserved. No package lifecycle scripts were run during local installation. The lockfile is generated with package-manager integrity metadata; no runtime credential, deployment or security setting was changed.

Authoritative advisory references identify the patched versions:

- [Next.js image optimization advisory](https://github.com/advisories/GHSA-2464-fhr4-w9xw): fixed in 16.4.1.
- [Next.js cache component advisory](https://github.com/advisories/GHSA-673q-mjm6-r5xr): fixed in 16.4.1.
- [Zod collection validation advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): fixed in 4.6.6.

Actual local verification: exact locked installation completed with lifecycle scripts disabled; a fresh npm audit reported zero vulnerabilities at every severity. Changed frontend TypeScript and lint checks passed. A cold UAT2-client Webpack build using Next.js 16.4.1 completed all 53 static-page entries. The build working tree also contained the separately developing private analysis export UI; this is frontend build evidence, not an exact-source full-application browser or hosted acceptance receipt. Static generation could not load dashboard owner data, as expected without an authenticated running backend.

Publication, exact-source CI, Linux package/runtime checks and new browser acceptance remain pending. Existing installed UAT2 and production dependencies were not modified. No broad npm audit fix or unrelated dependency upgrade is included.
