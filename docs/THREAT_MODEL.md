# BioCheck Technologies — Threat model (v1, 1:1 verification only)

Method: assets → actors → trust boundaries (see ARCHITECTURE.md) → STRIDE per boundary. Updated at each prompt phase. V1 scope excludes 1:N search, watchlists, covert collection, emotion inference and automated high-impact decisions — these are not merely disabled features, they are absent capabilities.

## Assets, ranked

1. Reference templates (encrypted embeddings) and any transient capture media.
2. Per-tenant data-encryption keys and the master/KMS key hierarchy.
3. Verification decisions and the audit chain (integrity, not confidentiality).
4. API keys, webhook secrets, session tokens.
5. Consent receipts and retention state (legal evidence).
6. Model files and the approved-model registry (a poisoned model is a systemic bypass).
7. PII: names, subject references, ID document fields (Prompt 4).

## Threat actors

External attacker (internet), malicious/compromised tenant, malicious end-user (presentation attack, replay, injection), insider (reviewer/admin), compromised dependency or model supply chain, cloud/infra compromise.

## Key threats and controls

### Spoofing / presentation attack
- Print/screen/video replay, deepfake injection → mandatory PAD, fail-closed on missing/low liveness (implemented in `policy.py`); active random challenge bound to one-use capture session (Prompt 2); attack-type recorded; PAD model independently registered — the sidecar cannot substitute models (implemented in `providers/seetaface.py`).
- Capture replay → nonce-bound, short-lived, one-use CaptureSession; idempotency keys; device attestation adapter (Prompt 4).
- Fake sidecar / MITM → mTLS both hops, model-hash verification of every response, HTTPS enforced outside localhost (implemented; env-gate the localhost path in Prompt 2 — gap G8).

### Tampering
- Audit falsification → hash-chained events (implemented), WORM export (Prompt 3), no raw biometrics in events (regression-tested from Prompt 3).
- Model substitution → registry gate on ID + SHA-256 + purpose + licence + independent report (implemented); unknown/changed model ⇒ REVIEW never approval; registry changes are super-admin, dual-controlled, audited (Prompt 5).
- Policy manipulation → policies immutable and versioned; every attempt records policy version (implemented at engine level; persistence Prompt 2).

### Repudiation
- Reviewer denies action → named-reviewer requirement on ReviewCase, immutable audit events, dual control for high-risk overrides; liveness failure never overridable without explicit exception policy + second approver (Prompt 4).

### Information disclosure
- Template theft → AES-256-GCM, per-tenant keys, templates never leave the private plane; KMS/HSM envelope encryption and production refusal of weak keys (Prompt 3).
- Cross-tenant read (IDOR) → server-side membership validation on every query; no trusted client org IDs; tenant-isolation integration tests gate CI (Prompts 1, 6).
- Leakage via logs/URLs/analytics → structured redacted logging, no capture bodies in any log (sidecar contract), no ID numbers in URLs, tests that raw payloads never reach logs/audit/ordinary columns (Prompt 3). Non-negotiable acceptance criterion.
- Evidence exposure → no public object URLs, masked side-by-side view only for authorised reviewers (Prompt 4).

### Denial of service
- Capture flood → rate limits per key/IP/tenant, 8 MiB size cap (implemented), MIME magic-byte validation, malware-scan adapter (Prompt 3), queue backpressure (Prompt 6).
- Sidecar outage → strict timeouts, fail closed to REVIEW/unavailable — never approve (implemented at client; wire through API in Prompt 2).

### Elevation of privilege
- Role sprawl → single policy layer, no scattered checks (Prompt 1); TOTP MFA for privileged roles; support impersonation only with explicit reason + audit (Prompt 5).
- API-key scope abuse → scoped keys per project/environment, IP allow-lists, secrets shown once and encrypted at rest (Prompts 1, 3).

### Supply chain
- Poisoned model weights → official-source pinning + SHA-256 manifest (done for SeetaFace6: 6 modules pinned 2026-07-14), manifest verification script before sidecar start, external reproducible build with recorded compiler/OS digests (build-status doc).
- Dependency compromise → lockfiles, dependency and secret scanning in CI, release blocked on critical findings (Prompt 6).

## Residual risks accepted at this phase

- Passive PAD effectiveness is unproven until the controlled pilot (`testing/PILOT_PROTOCOL.md`); no accuracy or liveness claims are made anywhere.
- SeetaFace6 provider is not independently certified by BioCheck (KNOWN_LIMITATIONS.md at Prompt 7).
- In-memory vault/audit are placeholders until Prompts 1–3 persistence lands; consequently nothing is deployed.

Review cadence: revisit this document at the end of every prompt phase and before the pilot.
