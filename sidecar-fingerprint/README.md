# BioCheck fingerprint sidecar (SourceAFIS) — FP-001

Implements the wire contract defined in `biocheck_engine/providers/fingerprint.py`:
`POST /v1/analyse`, `POST /v1/compare`, `GET /healthz`.

**Reality class: Prototype.** The matcher is [SourceAFIS](https://sourceafis.machinezoo.com/)
3.18.1 (Apache-2.0). All accuracy figures published by the SourceAFIS project are
vendor-reported; BioCheck makes no accuracy claims until FP-006 calibration.

## Build and run

Requires Docker (Maven fetches dependencies during the image build):

```bash
cd sidecar-fingerprint
docker build -t biocheck/fp-sidecar:0.1.0 .
docker run --read-only -e FP_SIDECAR_API_KEY=devkey -p 127.0.0.1:8081:8081 biocheck/fp-sidecar:0.1.0
```

Then run the conformance suite from the repo root:

```bash
FP_SIDECAR_URL=http://localhost:8081 FP_SIDECAR_API_KEY=devkey \
  pytest tests/test_fp_sidecar_conformance.py -v
```

To wire the engine to it: set `VERIFY_CORE_FP_SIDECAR_URL` / `VERIFY_CORE_FP_SIDECAR_API_KEY`
and register the model the sidecar reports (see below). Without these, fingerprint
endpoints keep failing closed (503) — that is correct behaviour.

## Model registration

The sidecar reports `model_id`, `matcher_model_id` and `model_sha256` (SHA-256 of
the actual SourceAFIS jar in the running image) on `/healthz`. Register `model_id`
for `fingerprint_extraction` and `matcher_model_id` for `fingerprint_matching`
(distinct IDs, same hash — the registry authorises one purpose per model ID), with
the Apache-2.0 licence reference. The registry gate means a substituted algorithm build
fails verification — same governance as the SeetaFace6 models.

## Documented mappings (placeholders until FP-006)

- **Score:** `normalised = min(raw, 100) / 100`. SourceAFIS raw similarity is
  unbounded; vendor guidance places raw 40 at roughly 0.01% FMR. Linear and
  monotonic, so current policy placeholders (approve 0.80 / review 0.55) mean
  raw 80 / raw 55 — conservative until calibrated on pilot data.
- **Quality:** `score = min(1, minutiae_count / 40)` — a transparent proxy, not
  NFIQ2. The engine's `min_quality 0.60` gate currently equals ≥ 24 minutiae.
  NFIQ2 integration is planned.

## Non-negotiable behaviours

- Images processed in memory only; never written, never logged; `retain_image=true` refused.
- `pad` is always `null` — PAD is never synthesised. Scanner-side live-finger
  detection enters through the capture agent (FP-004), not this service.
- Bearer auth mandatory; service refuses to start without `FP_SIDECAR_API_KEY`.
- Accepted image formats: grayscale PNG/JPEG/BMP (ImageIO). WSQ is not supported yet.
- Production: HTTPS/mTLS in front, isolated host, same posture as the SeetaFace6 sidecar.

## Build status honesty

Authored 17 Jul 2026 in a sandbox where Maven Central is unreachable, so the
service has **not yet been compiled or run**. FP-001 acceptance (conformance
suite green against the live service) completes after the first successful
`docker build` + run on a machine with normal network access. Until then this
directory classifies as **Prototype (unbuilt)** in the reality matrix.
