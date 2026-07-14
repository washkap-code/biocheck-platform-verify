# Data Protection Impact Assessment — tenant template

For completion by each BioCheck tenant before production use. BioCheck provides the technical descriptions; the tenant is responsible for the legal assessment under its applicable law (e.g. Zimbabwe's Cyber and Data Protection Act, POPIA, GDPR where relevant). This template does not constitute legal advice.

## 1. Processing description

- Tenant / organisation:
- Use case (e.g. member check-in, workforce attendance):
- Population (who is verified, approximate volume, any vulnerable groups):
- Data categories: live capture (transient), biometric template (encrypted reference), consent receipt, verification outcomes. Additional tenant fields:
- Purpose(s) of verification:
- Lawful basis selected (tenant determination):
- Notice shown to subjects (attach; record version used in `noticeVersion`):

## 2. Necessity and proportionality

- Why is biometric verification necessary for this purpose (what alternative was considered and why is it insufficient)?
- Is verification voluntary? What is the non-biometric fallback path for people who decline or cannot use it?
- Data minimisation: which optional fields/evidence retention are switched OFF?
- Retention: template expiry set to ____; evidence retention: zero / retained for ____ with purpose ____.

## 3. Technical measures provided by BioCheck (reference)

Consent-led 1:1 only (no 1:N search); templates AES-256-GCM encrypted with per-tenant KMS-wrapped keys; zero-retention capture default; single-use nonce-bound capture sessions; mandatory liveness fail-closed; human review path with named reviewers; append-only audit chain; subject export and deletion workflow with legal-hold handling; residency and transfer register; role-based access with MFA for privileged roles. See PRIVACY_AND_RETENTION.md and SECURITY_BASELINE.md.

## 4. Risks and mitigations (tenant assessment)

| Risk | Likelihood | Impact | Mitigation | Residual risk | Owner |
|---|---|---|---|---|---|
| False non-match denies a legitimate person service | | | Human review path; non-biometric fallback | | |
| False match grants access to the wrong person | | | Policy thresholds; review band; audit | | |
| Presentation attack (photo/replay) | | | Active challenge + PAD, fail-closed | | |
| Function creep (data reused beyond purpose) | | | Purpose in consent receipt; audit; contract | | |
| Exclusion of subjects unable to complete capture | | | Fallback path; accessibility of capture flow | | |
| Data breach of templates/evidence | | | Encryption, key rotation, incident response | | |

## 5. Consultation and sign-off

- Data protection officer / responsible person:
- Subjects or representatives consulted (if applicable):
- Decision (proceed / proceed with conditions / do not proceed):
- Review date:
