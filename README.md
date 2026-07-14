# BioCheck Verify Engine

> **Repository layout (since Prompt 1):** this root holds the Python
> verification core (`biocheck_engine`, the private verify-core service).
> The enterprise platform (tenancy, identity, permissions, audit, console)
> lives in [`platform/`](platform/) — Next.js App Router + TypeScript +
> PostgreSQL. See `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`,
> `docs/SECURITY_BASELINE.md` and `docs/BASELINE_AUDIT.md`.
>
> **Platform local setup (secure, `.env.example` only):**
> ```bash
> cd platform
> cp .env.example .env.local   # fill in values; never commit .env.local
> npm install
> npm test                     # 20 foundation tests (PGlite, no server needed)
> npm run seed                 # fake demonstration data only
> npm run dev
> ```

BioCheck Verify is an enterprise **1:1 biometric verification** core: it verifies
that a consenting person presenting a live selfie matches a reference portrait
(normally read from an identity document). It is deliberately not a 1:N watchlist
or surveillance product.

This repository provides the security-critical verification orchestration,
encrypted template vault, policy-based decisioning, immutable audit-chain
verification and an adapter boundary for independently evaluated face and
presentation-attack-detection (PAD) models.

## Production principles

- No facial image is persisted by the core service. Store only encrypted,
  versioned templates and retain images in a separately governed evidence vault
  only where a customer has a lawful need and consent/notice covers it.
- A production model adapter must be an approved ONNX model, pinned by SHA-256,
  with its licence, evaluation results, demographic results and supplier/model
  provenance recorded in the model registry.
- Liveness/PAD is mandatory for approval. A missing, failing or below-threshold
  PAD result always fails closed.
- The policy never makes eligibility, pricing, credit, employment, health or
  immigration decisions. It returns a verification result for a human/system
  workflow with an escalation path.

## Quick start

```bash
export BIOCHECK_MASTER_KEY_B64="$(python -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')"
python -m unittest discover -s tests -v
python -m biocheck_engine.demo
```

For the HTTP API, install the optional service dependencies and run
`uvicorn biocheck_engine.api:app`.

## Certification readiness

The codebase is an evidence-producing foundation, not a certificate or a claim
of certification. `docs/CERTIFICATION_ROADMAP.md` sets out the independent test,
security, privacy and governance work required before BioCheck makes any
certification claim.

See `docs/MODEL_GOVERNANCE.md` before importing any model. Do not assume that an
open-source repository means its weights are licensed for commercial biometric
use.

## Initial zero-licence provider

The first provider adapter is `biocheck_engine.providers.seetaface.SeetaFaceSidecar`.
It connects only to BioCheck's private SeetaFace6 inference service and rejects
any response whose recognition or PAD model hash is not explicitly approved.
Follow `docs/SEETAFACE6_INTEGRATION.md`; model files are intentionally not
bundled in this repository.

The verified source/model release details and reproducible native-build steps
are in `docs/SEETAFACE6_BUILD_STATUS.md`. Pilot collection and reporting are
controlled by `testing/PILOT_PROTOCOL.md` and `scripts/summarise_pilot_results.py`.
