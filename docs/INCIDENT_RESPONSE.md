# Incident response — BioCheck platform

Owner: platform_security_admin. Review after every incident and at least quarterly. This is an engineering runbook, not a substitute for the tenant's own regulatory notification obligations.

## Severity classification

- **SEV-1** — confirmed or suspected exposure of biometric templates, tenant DEKs/master key, or cross-tenant data access. Also: active exploitation of the verification decision path (spoof accepted at scale, model substitution).
- **SEV-2** — exposure of non-biometric personal data (consent records, subject refs), credential compromise (API key, privileged account), audit-chain verification failure.
- **SEV-3** — availability loss of verification service, webhook delivery outage, dead-letter buildup, repeated rate-limit abuse from a single tenant.

## First hour (any SEV)

1. Appoint an incident lead; open a timestamped incident log (facts only, no speculation).
2. Preserve evidence: audit chain export, relevant logs (already redacted), affected row IDs. Do NOT copy biometric ciphertext into tickets or chat.
3. Contain: revoke affected API keys/sessions (`revokeApiKey`, `revokeAllSessions`), disable affected webhook endpoints, and if a model or provider is implicated set its registry status to `revoked` — verifications will fail closed to review automatically.
4. For key compromise: rotate tenant DEKs (`rotateTenantDek`) and the KMS master key; retired versions stay decrypt-only for recovery.

## Biometric-specific rules

- Templates are non-reversible encrypted references; still treat any template exposure as SEV-1 and notify affected tenants without undue delay so they can meet their own legal obligations.
- Never attempt to "verify" whether leaked data matches real people — that is a prohibited use.
- If PAD bypass is suspected, move the affected policy's environments to review-all (repoint `active_policy_id` to a restrictive version) rather than disabling liveness checks.

## Communications

Single accountable communicator. Tenants are informed of: what happened, data categories affected, containment done, actions required from them (key rotation, webhook secret rotation). No speculation about attacker identity, no accuracy/impact claims that are not evidenced.

## Post-incident (within 5 working days)

Blameless review: timeline, root cause, detection gap, containment effectiveness; update THREAT_MODEL.md and this runbook; add a regression test that would have caught the issue; record actions with owners and dates in DECISIONS/PROJECT_STATUS.
