# Fingerprint verification — build status

**Last updated:** 15 Jul 2026
**Honest status: the software contract layer exists and is tested. No real
fingerprint capture, extraction or matching exists anywhere in BioCheck yet.**

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
