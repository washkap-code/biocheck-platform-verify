# Pilot readiness report — BioCheck platform

Date: 14 July 2026. Prepared for the controlled-pilot go/no-go decision. This is an engineering readiness statement, not a certification and not a production authorisation. BioCheck is not labelled as certified anywhere.

## 1. Automated verification run

| Gate | Result | Evidence |
|---|---|---|
| Platform test suite | **114 passing** across 7 suites | `platform/tests/*.test.ts` |
| — foundation (tenancy, RBAC, auth, audit) | 20 | foundation.test.ts |
| — verification core, consent, webhooks | 21 | verification.test.ts |
| — privacy, encryption, retention, leakage | 17 | privacy.test.ts |
| — documents, review ops, fraud | 15 | documents.test.ts |
| — end-to-end tenant journey | 9 | flows.e2e.test.ts |
| — reliability, jobs, config, observability | 12 | operations.test.ts |
| — **adversarial pre-pilot review** | **20** | adversarial.test.ts |
| Engine unit tests (`biocheck_engine`) | 8 passing | `tests/test_engine.py` |
| Type check (tsc) | clean | CI `platform` job |
| Production build (`next build`) | passing | CI `platform` job |
| Migration check (empty DB) | all 5 migrations apply | CI `platform` job |

Model manifest verification (`scripts/verify_model_manifest.py`) passed for the six SeetaFace6 v1 modules — see SEETAFACE6_BUILD_STATUS.md. Runs on the CI/build host, not against a live model in this environment.

## 2. Adversarial scenarios — attempted, contained

Each row was executed as a deliberate attack in `adversarial.test.ts`. All refused/contained.

| Ref | Scenario | Result | Unresolved risk | Owner | Remediation |
|---|---|---|---|---|---|
| A1.1–A1.3 | Cross-tenant read of verifications, capture sessions, audit, reviews; subjectRef collision | Refused; refs siloed per tenant | none | — | — |
| A2.1–A2.2 | API-key scope escalation; tampered/truncated/revoked keys | Refused + audited | none | — | — |
| A3.1–A3.2 | Capture-session replay; expired session reuse | Refused (one-use + expiry) | none | — | — |
| A4.1 | Webhook signature replay, stale timestamp, body tamper, wrong secret | All fail verification | Consumer must actually verify — documented in dev portal | Customer | Integration guidance shipped |
| A5.1–A5.2 | Model-hash swap; purpose swap; mid-flight revocation | Not approved; routes to REVIEW | Registry integrity depends on the KMS/admin controls | Platform admin | Dual-control on registry writes (Prompt 5) |
| A6.1–A6.3 | Liveness failure with matching face; exception-path abuse; missing/withdrawn consent | Rejected; exception disabled by default; matching blocked | Passive PAD strength unproven until pilot | ML assurance | Controlled pilot (this doc §5) |
| A7.1–A7.2 | Subject deletion (destroys template, blocks matching); cross-tenant deletion | Completed within tenant; cross-tenant refused | none | — | — |
| A8.1–A8.2 | Reviewer deciding in another org; API principal as reviewer; analyst reviewing | All refused | none | — | — |
| A9.1–A9.2 | Marked capture payload leakage across 12 tables + logs; audit-chain integrity | No leakage; chain intact | none | — | — |
| A10.1 | Login brute force | Account locked before success | Add per-IP throttling at the edge for defence in depth | Platform | Prompt 3 rate limiter; wire at gateway |

## 3. Non-negotiable acceptance criteria — status

- No 1:N search / surveillance / unconsented collection — **absent by design** (not a toggle).
- No raw facial capture/embedding in logs, app logs, URLs, analytics, audit or unencrypted DB fields — **proven** (A9.1, privacy leakage tests).
- Every verification carries tenant/project, consent reference, policy version, model hash/version, reason codes and tamper-evident audit — **implemented and tested**.
- Liveness failure / missing consent / unknown model hash / inference outage → fail closed or human review, never silent approval — **proven** (A5, A6; provider-outage test).
- Every customer-data operation enforces tenant isolation server-side — **proven** (A1, A7, A8).
- No "certified / fraud-proof / 100% accurate" claim — **verified**; marketing copy and dev portal reviewed, claims register maintained.
- Production remains manually gated after pilot + pen test + privacy/security approval — **enforced** by PRODUCTION_RELEASE_CHECKLIST.md.

## 4. Residual risks carried into the pilot

1. **Passive PAD effectiveness is unmeasured.** No FAR/FRR/APCER/BPCER numbers exist. The pilot exists to produce them. Until then, no accuracy claim is made and high-impact decisions must not rely on the platform.
2. **SeetaFace6 provider is not independently certified by BioCheck** (KNOWN_LIMITATIONS.md).
3. **No production sidecar binary yet** — build on the isolated Linux builder before pilot (SEETAFACE6_BUILD_STATUS.md).
4. **Independent penetration test not yet performed** — required before production, not before a controlled non-production pilot.
5. **Browser-level e2e (Playwright)** is specified for CI but the browser runner is not exercised in this environment; the integration-level e2e journey stands in until then.

## 5. Recommendation

**Ready for a controlled, consented, non-production pilot** under `testing/PILOT_PROTOCOL.md`, once the sidecar binary is built and its exact model hashes are registered in a test-only registry. Not ready for, and explicitly gated against, production use. Go/no-go for production is the PRODUCTION_RELEASE_CHECKLIST, not this report.
