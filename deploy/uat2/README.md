# UAT2 preparation

This is an incomplete, deliberately non-launchable candidate. Do not deploy it.
No scheduler, worker, broker CLI, public database port or production role is included.
The application startup lock must remain until simulation adapters, a bounded Google
verification egress route, distinct cookies, and integration tests are implemented.
The internal network deliberately has no internet route: Google certificate verification
currently cannot work. Do not solve that by attaching backend/frontend to `edge`.

Before use: verify supported image tags and pin all images to reviewed digests; build
actual application images outside the server without production configuration. Resolve
independent credentials via the mandated aws-secrets-manager skill and asm-exec.
Do not use production Dockerfiles unchanged: backend installs an unnecessary broker CLI
and uses reload; frontend uses Node 20 and requires UAT2 build-time configuration review.
This topology is a configuration review artifact, not a tested deployment command.
