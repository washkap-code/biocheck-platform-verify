# Known limitations — BioCheck platform

Read this before any deployment decision. These statements are deliberate and must not be softened in marketing, sales or product copy.

## Certification and accuracy

- **BioCheck is not certified.** No independent body has certified the platform, the SeetaFace6 provider, or any model. The codebase produces evidence toward future certification; it is not itself a certificate.
- **No accuracy figures exist.** There are no validated FAR, FRR, TAR, APCER or BPCER numbers. Any number seen in a demo or sandbox is simulation output and is labelled as such. Do not quote demo numbers as performance.
- **The current SeetaFace6 provider is not independently evaluated by BioCheck.** Its open-edition licence permits commercial use, but BioCheck has not run its own demographic and capture-condition evaluation. That evaluation is a prerequisite for production, not for a controlled pilot.
- **The fingerprint matcher (`sidecar-fingerprint-py/`, added 21 Jul 2026) is a from-scratch classical algorithm, not a vendor product.** It has no published benchmark numbers of any kind (unlike SourceAFIS, which at least has public FVC results, even though BioCheck hasn't independently validated those either). Its own measured discriminative accuracy on synthetic test data is ~83% correct ordering (10/12 trials) — see `docs/FINGERPRINT_BUILD_STATUS.md` — which is evidence it works as a real matcher, and simultaneously evidence it is nowhere near production accuracy.

## Presentation-attack detection

- **Passive PAD is unproven.** Its effectiveness against print, screen, video-replay and injection attacks has not been measured on BioCheck's own test set. The controlled pilot (`testing/PILOT_PROTOCOL.md`) exists to measure it.
- Active challenge-response is implemented in the capture flow. Passive PAD alone is not sufficient for high-risk remote identity proofing, and the platform does not claim it is.

## Scope boundaries (by design, not omission)

- **V1 is 1:1 verification only.** There is no 1:N identification, no watchlist, no background or public-space matching, no covert collection, no emotion or demographic inference, and no automated high-impact decision-making. These are absent capabilities, not disabled features.
- The platform returns a verification result with an escalation path. It does **not** make eligibility, pricing, credit, employment, health, immigration or benefits decisions. Those remain with the customer's human/system workflow.

## Deployment state

- **No production sidecar binary has been built in this environment.** The hosted workspace terminates long native compilations. The SeetaFace6 sidecar must be built on a designated isolated Linux builder, with binary hashes, compiler version and OS image digest recorded (SEETAFACE6_BUILD_STATUS.md).
- **verify-core FastAPI facade** (`/v1/analyse`, `/v1/templates`, `/v1/compare`) is specified and the platform-side client is complete and tested, but the Python HTTP endpoints are to be built alongside the sidecar.
- **No independent penetration test** has been performed. Required before production.
- **KMS/HSM** (added 22 Jul 2026): a real `AwsKmsAdapter` and a real `keys.rotation_execute` job now exist (`docs/KMS_BUILD_STATUS.md`), tested against a mocked AWS SDK client and a real Postgres-backed job queue — 9/9 + extended `operations.test.ts` passing. Production now refuses to boot unless `BIOCHECK_KMS_PROVIDER=aws` and `BIOCHECK_KMS_KEY_ID` are set. **This has never been run against a real AWS account** — no AWS credentials exist in this environment, so the adapter's request/response handling is proven against the SDK's documented contract, not against a live KMS key, IAM policy or network path. GCP KMS / on-prem HSM adapters are not built; only AWS.
- **Approved Concept 1 logo assets** are referenced but not present in `public/brand/`; drop the supplied SVGs in before launch.
- **Browser-level e2e (Playwright)** is defined for CI but not exercised here; integration-level e2e covers the same journeys in the interim.

## Data and legal

- BioCheck provides technical controls and configurable policy fields. It makes **no legal-compliance determination** on any tenant's behalf. Lawful basis, notices, retention periods and DPIAs are the tenant's responsibility (DPIA_TEMPLATE.md, PRIVACY_AND_RETENTION.md).
- No real biometric data has been created or ingested during development. All fixtures are synthetic JSON.

## The one-line summary

The platform is a well-tested, privacy-first 1:1 verification foundation ready for a consented controlled pilot. It is not certified, its accuracy and liveness performance are unmeasured, and no production or high-impact decision should rely on it until the pilot and an independent review are complete.
