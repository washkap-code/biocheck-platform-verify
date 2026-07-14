# Production release checklist — BioCheck platform

No production deployment happens until EVERY item below carries a name, evidence reference and date. This checklist is the manual gate after CI; automation cannot complete it. Copy this file into the release record and fill it in.

Release: ____________  Image digest: ____________  Date: ____________

## Engineering evidence

- [ ] CI green on the exact release commit (typecheck, full test suite, migration check, secret scan, dependency scan, build). Run link: ______
- [ ] Migration plan reviewed (expand/contract staged; rollback path stated). Reviewer: ______
- [ ] Staging soak completed with the release image digest; smoke journey passed (capture session → verification → webhook). Evidence: ______

## Model and biometric governance

- [ ] Model hash attestation: SHA-256 of every deployed recognition/PAD/detection/quality model verified against `model-manifest/…` and the model registry (`scripts/verify_model_manifest.py` output attached). Verifier: ______
- [ ] Model cards approved: licence review, independent 1:1 + PAD test report references, demographic breakdowns, threshold calibration from held-out data. Approver: ______
- [ ] Sidecar binary provenance: built on the designated isolated Linux builder; binary hashes, compiler version and OS image digest recorded per `docs/SEETAFACE6_BUILD_STATUS.md`. Builder: ______
- [ ] Controlled pilot report signed (per `testing/PILOT_PROTOCOL.md`): results reviewed including every false accept/reject. Signatory: ______

## Privacy and security approvals

- [ ] Privacy assessment: DPIA completed for the launching tenant(s); retention configuration reviewed (evidence retention purpose + expiry, or zero). Reviewer: ______
- [ ] Penetration test: report received, criticals/highs remediated or risk-accepted in writing. Ref: ______
- [ ] KMS/HSM configured; `assertProductionKeyConfig` passes; key rotation schedule live. Operator: ______
- [ ] Incident contact + escalation rota confirmed (INCIDENT_RESPONSE.md owners current). On-call: ______

## Operational readiness

- [ ] Backups verified: latest restore drill within 90 days, RPO/RTO targets met. Drill record: ______
- [ ] Monitoring live: readiness alerts, dead-letter job alerts, dead-webhook alerts, review-SLA breach alerts. Dashboard: ______
- [ ] Rollback plan written for THIS release (previous digest + migration posture). Author: ______

## Final sign-off

- [ ] Named release approver (accountable executive): ______  Date: ______
- [ ] Marketing/claims check: no new public claim of certification, accuracy or compliance is introduced by this release. Checker: ______

> Reminder from the acceptance criteria: production remains manually gated
> after controlled pilot evidence, penetration testing and privacy/security
> approval. A missing item above is a stop, not a note.
