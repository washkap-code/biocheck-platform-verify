# Model governance and approved-model gate

## What BioCheck owns

BioCheck owns the capture workflow, decision policy, threshold calibration,
template-protection scheme, tenant isolation, audit trail, model registry,
evaluation harness and deployment controls. It may train a BioCheck-owned
embedding/PAD model only on data it has a documented right to use.

It must never represent a third-party model as its own, scrape faces, train on
customer biometric data by default, or use a model whose weights prohibit the
intended commercial deployment.

## Initial model strategy

1. **Face detection/alignment:** a commercially permitted ONNX detector; assess
   recall on relevant cameras, skin-tone distribution, masks and extreme pose.
2. **Face embedding (1:1):** begin with an ArcFace-family architecture only as
   a research benchmark. Production weights require a separate commercial-use
   review. Train BioCheck's own architecture/weights from licensed data or use a
   vendor model with an explicit commercial licence.
3. **PAD/liveness:** implement a challenge-response active PAD plus a separately
   evaluated passive PAD model. Neither score alone is sufficient for high-risk
   remote onboarding.
4. **Document portrait extraction:** use OCR/document authentication as a
   separate service. Matching a selfie to a document photo does not validate the
   document itself.

## Model registry admission checklist

Every deployed model version must have all of the following before release:

- immutable model ID, SHA-256, architecture and input/output contract;
- signed licence review confirming commercial biometric use and redistribution;
- training-data provenance, consent/rights statement and retention policy;
- independent 1:1 verification and PAD test report, including demographic and
  capture-condition breakdowns;
- threshold calibration from an untouched validation set, with FAR/FRR/TAR and
  confidence intervals; thresholds are not copied from a competitor;
- red-team report covering print/replay, screen replay, mask, injection and
  deepfake attacks;
- rollback plan, human-review route, monitoring thresholds and expiry/retest date.

## Existing-model benchmarking, not imitation

Use published, licensed research implementations to compare performance. Do not
reverse engineer or attempt to reproduce proprietary APIs, embeddings, training
data, thresholds or protected model weights from FacePhi, iProov, AWS, Microsoft,
FaceTec or another provider. Those vendors are benchmarks for product capability,
not sources to copy.

Candidate sources should be screened by counsel and ML governance before use:

| Category | Candidate | Admission rule |
|---|---|---|
| Face embedding research baseline | ArcFace-style implementations | Architecture is research; check the exact weight licence independently. |
| Face embedding implementation | `facenet-pytorch` / `deepface` ecosystem | Code licence does not automatically license every bundled model. |
| Detection/alignment | OpenCV/ONNX-compatible detector | Pin model hash and validate performance on target cameras. |
| Passive PAD | Research models / independent PAD vendor | Require attack-instrument test evidence; no self-attestation. |

The first commercial deployment may use SeetaFace6 under its published
commercial-use terms behind BioCheck's adapter, subject to retaining its notices
and completing BioCheck's model admission checks. BioCheck should still train
and validate its own models over time, and must not make unsupported performance
or certification claims.
