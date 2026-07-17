# BioCheck FP Mission Pack — Real Fingerprint Verification

**Programme:** BioVerify Engine — Fingerprint Capability
**Pack ID:** FP (v1.1 — revised against repo state after folder audit)
**Date:** 17 July 2026
**Status:** Proposed — awaiting FP-000 decisions
**Owner:** BioCheck Technologies

---

## 1. Objective and current state

Make fingerprint verification real: scanner capture → quality check → template extraction → protected storage → 1:1 verify, inside the existing `biocheck_engine` architecture.

**Important: the software contract layer already exists** (commit `80c2c09`, 15 Jul 2026, per `docs/FINGERPRINT_BUILD_STATUS.md`):

- Engine: `FingerprintVerificationPolicy` (quality/minutiae gates, PAD-required approval cap), sidecar wire contract in `providers/fingerprint.py` (`/v1/analyse`, `/v1/compare`), model-registry gates for `fingerprint_extraction`, `fingerprint_pad`, `fingerprint_matching`.
- verify-core facade: `/v1/fingerprint/analyse`, `/v1/fingerprint/templates`, `/v1/fingerprint/compare`; single-use capture refs; separate AAD context (face/fingerprint ciphertexts can never cross-replay); **503 fail-closed with no adapter configured**.
- Platform: migration 0006 (modality column, immutable `fingerprint_policies`), `enrolFingerprint`/`verifyFingerprint`, modality-mismatch refusal, OpenAPI updated.
- Test evidence: engine 47/47, platform 133/133.

**What does not exist anywhere:** real capture, real extraction, real matching.

**Reality matrix:** software contract layer = Prototype; capture/extraction/matching = Planned; website demo = Demonstration.
**Target at pack completion:** fingerprint end-to-end = **Prototype** on real hardware. Pilot/Production claims require FP-006 evidence.

---

## 2. Engine decision

We integrate an existing matching engine behind the already-defined wire contract. We do not write a matching algorithm from scratch. `FINGERPRINT_BUILD_STATUS.md` already names the two candidates; this pack selects between them.

### Primary: SourceAFIS (Apache-2.0)

- Mature minutiae-based matcher; pure Java (latest 3.18.1, Java 11+) with an identical .NET twin.
- 1:1 verify and efficient 1:N search (vendor-reported ~10,000 fingerprints/sec search; ~3.6% EER on FVC-onGoing — **vendor-reported figures, not BioCheck claims**).
- Free, no per-device fees, source auditable — right fit for prototype and early pilot.

### Cross-check: NIST NBIS (public domain)

MINDTCT + BOZORTH3 as an independent second opinion during calibration, and WSQ handling if needed.

### Bundled option: SecuGen SDK matcher

SecuGen's free SDKs include vendor-stated NIST MINEX-certified extraction/matching. If the SecuGen scanner is chosen, keep it as a third comparison baseline in FP-006.

### Commercial upgrade path (deferred)

VeriFinger / Innovatrics / Griaule when a contract requires certified accuracy, large-scale 1:N, or vendor support. The provider architecture makes this a sidecar swap, not a rewrite. Trigger: commercial requirement.

---

## 3. Scanner decision (FP-000)

### Recommended: SecuGen Hamster Pro 20

- Free SDKs for Windows, Linux and Android (Linux matters — sidecar hosting is Linux).
- Vendor-stated FBI certification and MINEX-certified algorithms — **verify current certificate status at purchase; publish nothing until verified**.

### Alternative: Futronic FS88

Linux SDK available (FS80/FS82/FS88 family); FBI PIV-class device (vendor-stated; verify at purchase).

### Selection criterion carried from the engine's safety design

The policy **never auto-approves without a live PAD (fake-finger) result** — strong match with absent PAD caps at human review. PAD is hardware-dependent, so the scanner's fake-finger-detection capability must be confirmed with the vendor before ordering. If the chosen device has no PAD, that is acceptable for prototype but every approval stays human-review-capped — say so honestly in the console UI.

**Procurement:** 2 development units in FP-000.

---

## 4. Architecture

Only two net-new components. Everything else exists and is tested.

```
Browser / Console UI
      │  localhost
      ▼
[NEW] BioCheck Capture Agent  — local app bundling scanner vendor SDK;
      │                          capture → quality gate → one-use capture session
      ▼
[EXISTS] Platform /v1 fingerprint routes → biocheck_engine policy/vault/audit
      │                                     (fail-closed, 503 without adapter)
      ▼
[NEW] Fingerprint Sidecar     — implements the existing wire contract:
                                 /v1/analyse  → ISO 19794-2 or engine-native template
                                                + quality score + minutiae count
                                 /v1/compare  → match score mapped to documented,
                                                calibrated 0–1 scale
                                 + deployed algorithm file hashes in every response
                                 (same isolated-Linux-host posture as SeetaFace6 sidecar)
```

Carried-over rules: raw images transient, only encrypted templates stored; audit events on every path; thresholds in policy (current numbers — min_quality 0.60, min_minutiae 16, approve 0.80, review 0.55 — are placeholders until FP-006); website demo stays a labelled simulation.

---

## 5. Missions

Each mission ends with a completion report, green tests, and an updated PRODUCT_REALITY_MATRIX. No completion with failing gates.

### FP-000 — Decisions and procurement (user + Claude)

- Confirm SourceAFIS as primary engine (default if no objection).
- Choose scanner; confirm PAD capability with vendor; order 2 units.
- Confirm capture-agent first target OS (Windows enrolment desk is the common case).
- Confirm JVM runtime acceptable on sidecar host.
- **Acceptance:** DECISIONS.md updated; order placed; reality-matrix rows confirmed.

### FP-001 — Fingerprint sidecar (no hardware; can start now)

- JVM service wrapping SourceAFIS 3.x implementing the wire contract exactly as specified in `providers/fingerprint.py` and `FINGERPRINT_BUILD_STATUS.md`: `/v1/analyse` (template + quality + minutiae count), `/v1/compare` (score with documented 0–1 mapping), algorithm file hashes in every response; health endpoint; Docker image.
- Tests with licence-checked public sample fingerprints; deterministic scores.
- **Acceptance:** engine's existing sidecar-client tests pass against the real service (not fixtures); score-mapping documented; no BioCheck accuracy claims.

### FP-002 — Model governance + integration hardening (no hardware)

- Register extractor/matcher in the model registry with licence evidence and an independent evaluation reference (SourceAFIS FVC-onGoing entry), per `MODEL_GOVERNANCE.md`. Dev-fixture cards must never appear in production (already enforced — verify).
- Wire `VERIFY_CORE_FP_SIDECAR_URL`/`API_KEY` config path end-to-end in a staging-like run; confirm 503 fail-closed behaviour flips to live correctly.
- **Acceptance:** full engine + platform suites green against the live sidecar; model registry entries complete.

### FP-003 — Console surfaces (no hardware)

- Console enrolment and verification screens for fingerprint (the API routes exist; the UI flows and result states — verified / no match / PAD-unavailable review / service-unavailable — need building), with honest PAD-cap messaging.
- **Acceptance:** tsc clean, UI tests green, every state reachable and honestly labelled.

### FP-004 — Capture agent (blocks on hardware delivery)

- Local app bundling the vendor SDK; localhost endpoint for the console; capture → quality score → image bytes into a one-use capture session; never stores images; clean uninstall.
- **Acceptance:** live capture from physical scanner into console enrolment; quality gate rejects bad captures.

### FP-005 — End-to-end prototype (hardware)

- Full path with at least two consented team members: enrol, 1:1 verify, no-match with non-enrolled fingers, PAD-review path.
- **Acceptance:** recorded end-to-end demo; PRODUCT_REALITY_MATRIX capture/extraction/matching → **Prototype**; website copy updated only to what is then true.

### FP-006 — Calibration and pilot protocol (hardware + participants)

- Adapt the SeetaFace6 pilot protocol: consented participants, threshold sweep, measured FAR/FRR **on pilot data, labelled as pilot data**; NBIS (and SecuGen, if applicable) cross-checks; scripted report like the v0.3 pilot-summary scripts.
- Replace the placeholder policy thresholds with calibrated values, evidence-linked.
- **Acceptance:** calibration report committed; go/no-go recommendation for pilot classification.

### FP-007 — Claims, Trust Centre, commercial readiness

- CLAIMS_REGISTER.md + Trust Centre updates; data-handling documentation (transient images, encrypted templates, deletion path); consent language aligned with the existing `DPIA_TEMPLATE.md` and Zimbabwe Data Protection Act review; commercial-engine upgrade trigger documented.
- **Acceptance:** every public fingerprint statement traceable to evidence or labelled Planned/Prototype.

---

## 6. Dependencies on Washington

1. FP-000 decisions (engine confirm, scanner + PAD confirmation, agent OS, JVM approval) and scanner purchase.
2. Sidecar hosting — shared with the face rollout: isolated Linux host behind HTTPS (+ Redis for staging gates).
3. Consented pilot participants for FP-006.
4. `git push` of the three pending local commits (`80c2c09`, `c3f33c8`, `0ed9543`) so work builds on pushed state.

## 7. Risks

- Vendor-stated certifications (SecuGen/Futronic FBI/MINEX) must be re-verified at purchase; component certification is never presented as BioCheck certification.
- The browser↔scanner bridge (capture agent) is the least standardised piece; kept deliberately minimal.
- Open-source matcher accuracy is adequate for prototype/pilot scale; government-grade or large 1:N needs the commercial path. Promise nothing beyond that.
- Without hardware PAD, approvals stay human-review-capped by design — a throughput limitation to communicate, not hide.

## 8. Sequencing

FP-001 → FP-003 need no hardware and can run in parallel with the Phase A Vercel deploy and sidecar-host setup. Order the scanner in FP-000 immediately to keep hardware off the critical path.

---

*Repo facts from `biocheck-verify` at commit `0ed9543` (`docs/FINGERPRINT_BUILD_STATUS.md`, 15 Jul 2026). Engine/scanner facts from vendor documentation (SourceAFIS docs; SecuGen SDK/driver pages; Futronic SDK pages), retrieved 17 Jul 2026. All performance and certification figures are vendor-reported, not BioCheck claims.*
