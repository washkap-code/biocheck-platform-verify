# Fingerprint verification — build status

**Last updated:** 21 Jul 2026
**Honest status: a real, running, tested minutiae-matching software layer now
exists (Python, not the originally-planned SourceAFIS/Java), verified through
the actual production facade end-to-end. It is still NOT enterprise-grade or
production: no scanner hardware, no PAD, no calibration on a real fingerprint
dataset, and no independent evaluation exist. No real fingerprint capture
exists anywhere in BioCheck yet — the only inputs tested are procedurally
generated synthetic ridge images.**

## 21 Jul 2026 — Python fingerprint sidecar built, run, and verified end-to-end

Answering directly: **can the platform verify fingerprints at an enterprise-
grade level today? No.** Enterprise-grade requires real scanner hardware,
presentation-attack detection, threshold calibration against a real validated
dataset, and independent evaluation — none of those can be produced inside a
software sandbox with no hardware access and no biometric test corpus. What
*was* closeable from inside this environment — a real, running, tested
matching engine, since the previously-authored one had never been compiled —
has been closed.

**Why not finish the Java/SourceAFIS sidecar instead:** confirmed hard
infrastructure limits, not a lack of trying. No root access (`sudo` refuses:
"no new privileges" flag set). The network egress allowlist blocks both Maven
Central (`repo1.maven.org`) and Eclipse Adoptium (`api.adoptium.net`) — both
return `403 blocked-by-allowlist` on direct test. A GitHub Releases mirror of
a Temurin JDK 17 tarball is reachable in principle but its size exceeds this
session's execution window. This is a task for whoever has infra/allowlist
access, not something an agent session can route around.

**What was built instead**, in `sidecar-fingerprint-py/` (full detail and all
limitations in that directory's own `README.md` — read it before quoting this
anywhere):
- A from-scratch classical minutiae matcher: CLAHE + Otsu binarisation,
  skeletonisation, crossing-number minutiae extraction, gradient-based
  orientation estimation, and an alignment-search matcher (numpy / OpenCV /
  scikit-image only — no learned model, not SourceAFIS).
- Speaks the *exact same* wire contract as the unbuilt Java sidecar
  (`providers/fingerprint.py` was always algorithm-agnostic), so it's a
  drop-in `VERIFY_CORE_FP_SIDECAR_URL` target — no engine code changed.
- **15/15 of its own conformance checks pass** (auth required, `retain_image`
  refused, contract fields present, `pad` always null, score bounds,
  same/different-finger ordering, self-compare ≈ 1.0).
- **5/5 of the engine's own pre-existing conformance suite**
  (`tests/test_fp_sidecar_conformance.py`) now pass — for the first time,
  since it was always skipped before (no sidecar had ever run). One
  assertion (`model_id.startswith("sourceafis")`) was relaxed because the
  contract never actually required that algorithm specifically.
- **Full end-to-end HTTP proof through the real facade**
  (`biocheck_engine/api.py`), not just the sidecar in isolation: enrol →
  `/v1/fingerprint/analyse` → `/v1/fingerprint/templates` (real AES-GCM
  encrypted ciphertext) → `/v1/fingerprint/compare`. Same-finger scored
  0.606, different-finger scored 0.286 (correct ordering); reusing a
  `capture_ref` was correctly rejected with 409. Persisted as
  `tests/test_fp_end_to_end_facade.py` (2/2 passing, reproducible).
- **A 12-trial randomised statistical check** across varied synthetic
  parameters (not one cherry-picked seed): mean same-finger score 0.56 vs
  mean different-finger score 0.29; correct ordering in 10/12 trials (~83%).
  That's real, measured discriminative signal — and also an honestly-reported
  limitation nowhere near production accuracy.
- Full suite still green throughout: engine 8/8 unittest, platform-adjacent
  `tests/` 113 passed + 5 skipped (the 5 are the sidecar-conformance tests,
  which skip unless `FP_SIDECAR_URL` is set — they pass when it is, see
  above).

**Classification (per the "reality matrix" discipline used across this
project):** the fingerprint *matching software* moves from "Prototype
(unbuilt)" to **"Prototype (built, running, conformance-tested)."** It does
**not** move to Production or "enterprise grade." Everything in the "what
must exist before fingerprint is real" list below is unchanged and still
outstanding — this update closes zero of those five items; it adds working
software where there was previously none.

## 17 Jul 2026 — FP-001: SourceAFIS sidecar authored

- `docs/FP_MISSION_PACK.md` added — full build plan (FP-000 … FP-007), engine
  and scanner decisions, and the procurement guide
  (`BioCheck_Fingerprint_Hardware_Procurement_Guide.pdf` at project root).
- `sidecar-fingerprint/` added: Java 17 service wrapping SourceAFIS 3.18.1
  implementing the wire contract in `providers/fingerprint.py` exactly
  (`/v1/analyse`, `/v1/compare`, `/healthz`), Maven build, multi-stage
  Dockerfile, README. Documented placeholder mappings: score
  `min(raw,100)/100`; quality `min(1, minutiae/40)` (NFIQ2 planned). PAD is
  never synthesised (`pad: null`). Distinct extraction/matcher model IDs, jar
  SHA-256 reported for registry pinning.
- `tests/test_fp_sidecar_conformance.py` added: 5 live-service conformance
  tests (contract fields, score ordering, auth required, retain_image refused,
  health identity) using an in-process synthetic PNG generator. Skipped unless
  `FP_SIDECAR_URL` is set; full suite remains green (47 passed, 5 skipped).
- **Not done, stated plainly:** the sidecar has not been compiled or run —
  Maven Central is unreachable from the build sandbox. FP-001 acceptance
  completes on the first successful `docker build` + green conformance run on
  a normally-networked machine. Classification: Prototype (unbuilt).

## 17 Jul 2026 — FP-002 + FP-003 (same session)

- `scripts/register_fp_sidecar.py`: operator tool that queries a live sidecar's
  `/healthz` and emits the two ModelCards (extraction + matcher, distinct IDs,
  same jar hash) for `VERIFY_CORE_APPROVED_MODELS_JSON`. Requires an explicit
  `--approved-by` human. 4 tests green against the real registry gate.
- `platform/src/app/verify/FingerprintFlow.tsx`: consent-first fingerprint
  capture UI. Probes for the future Capture Agent on `127.0.0.1:9310`
  (contract for FP-004: `/agent/health`, `/agent/capture`), states plainly when
  it is absent, and never simulates a scanner. Dev-only image upload is gated
  by a server-side prop and must never be set in production. All decision
  states surfaced with honest explanations (PAD review cap, fail-closed
  SERVICE_UNAVAILABLE, quality guidance).
- Verification caveat: `tsc --noEmit` clean; the platform vitest suite could
  not be executed in this session's sandbox (runner hung producing no output —
  environmental). Run `npm test` in `platform/` on the next machine/CI before
  any deploy that includes these commits.

## 18 Jul 2026 — Verify Lab (console testing surface)

- `app/console/verify-lab/` + `app/api/console/verify-lab/`: signed-in console
  users can exercise the REAL enrol/verify pipeline (capture sessions, policy,
  model governance, audit) for both modalities. The tenant API key is held in
  an HttpOnly cookie scoped to the lab endpoints, re-authenticated on every
  call, and **production-kind environment keys are refused**. Audit
  attribution stays on the API key, identical to /v1 traffic. Dev-only image
  upload for fingerprint is double-gated (server env + component prop).
- Fix `53f963c`: cookie constants moved to `server/console/labCookie.ts` —
  Next.js route modules may only export handlers.
- Verification caveat: neither `tsc --noEmit` nor vitest could complete in
  this session's sandbox (filesystem mount degraded; processes hung with no
  CPU). Before deploying: `npx tsc --noEmit && npm test` in `platform/`.
  The lab files were hand-audited against service/type signatures.

## What was built (15 Jul 2026)

The fingerprint modality now mirrors the face architecture end-to-end, fail-closed:

| Layer | What exists | Reality class |
|---|---|---|
| Engine policy (`biocheck_engine/policy.py` → `FingerprintVerificationPolicy`) | Quality/minutiae gates, PAD-required approval cap, threshold bands | Prototype (thresholds are placeholders, not calibrated) |
| Engine sidecar client (`biocheck_engine/providers/fingerprint.py`) | Wire contract for the future fingerprint service: `/v1/analyse`, `/v1/compare`; model-registry gates for `fingerprint_extraction`, `fingerprint_pad`, `fingerprint_matching` | Prototype (contract only — no real service behind it) |
| verify-core facade (`biocheck_engine/api.py`) | `/v1/fingerprint/analyse`, `/v1/fingerprint/templates`, `/v1/fingerprint/compare`; single-use capture refs; separate AAD context so face/fingerprint ciphertexts can never be cross-replayed; **503 fail-closed when no fingerprint adapter is configured** | Prototype |
| Platform (`migration 0006`, providers, decision, service, /v1 routes) | `modality` column on capture sessions / templates / attempts; immutable `fingerprint_policies`; `enrolFingerprint` / `verifyFingerprint`; modality-mismatch refusal; OpenAPI updated | Prototype |
| Dev fixtures (engine + platform FakeProvider) | Deterministic JSON fixtures, refuse production | Demonstration (tests/dev only) |
| Website fingerprint demo | Unchanged — clearly labelled simulation | Demonstration |

**Test evidence:** engine 47/47 (24 new), platform 133/133 (19 new, incl.
cross-modality isolation and PAD-cap tests). Migration 0006 applies cleanly.

## Deliberate safety property

Fingerprint PAD (fake-finger detection) is hardware-dependent. The decision
policy therefore **never auto-approves without a live PAD result** — a strong
match with absent PAD is capped at human review (`PAD_UNAVAILABLE_REVIEW_REQUIRED`).
A failed PAD rejects. This holds in both the engine policy and the platform
mirror, and is tested in both.

## What must exist before fingerprint is real (owner actions)

1. **Scanner hardware + capture SDK.** Choose a scanner family (e.g. optical
   USB scanners with vendor SDK or WebUSB path). Capture happens client-side;
   the platform only ever receives image bytes inside a one-use capture session.
2. **Fingerprint sidecar service** implementing the wire contract in
   `providers/fingerprint.py`, on an isolated Linux host (same posture as the
   SeetaFace6 sidecar). Candidate engines: NIST NBIS (mindtct + bozorth3,
   public domain) or SourceAFIS (Apache-2.0). The sidecar must:
   - return an ISO/IEC 19794-2 (or engine-native) template, quality score and
     minutiae count from `/v1/analyse`;
   - compute the match score in `/v1/compare` and map it to a calibrated 0–1
     scale (document the mapping);
   - report the exact deployed model/algorithm file hashes in every response.
3. **Model governance.** Register extractor/matcher (and PAD, when hardware
   supports it) in the model registry with licence evidence and an independent
   evaluation reference. Dev-fixture cards must never appear in production.
4. **Threshold calibration + pilot.** The default policy numbers
   (min_quality 0.60, min_minutiae 16, approve 0.80, review 0.55) are
   placeholders. Calibrate on the pilot protocol before any accuracy language
   is used anywhere.
5. **Claims discipline.** Until 1–4 are done, all public material must keep
   labelling fingerprint as simulated/planned. PRODUCT_REALITY_MATRIX updated
   accordingly (software layer: Prototype; capture/matching: Planned).

## Configuration

- `VERIFY_CORE_FP_SIDECAR_URL` + `VERIFY_CORE_FP_SIDECAR_API_KEY` — real sidecar
  (HTTPS/mTLS outside localhost).
- `VERIFY_CORE_DEV_FIXTURES=true` — dev fixtures (refused in production).
- Neither set → fingerprint endpoints return 503 and platform attempts route
  to human review (`SERVICE_UNAVAILABLE`). Face-only deployments stay valid.
