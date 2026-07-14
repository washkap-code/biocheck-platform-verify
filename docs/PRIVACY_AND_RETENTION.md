# Privacy and retention — how BioCheck handles personal data

Scope: facial images, biometric templates, identity document details and verification events. These are treated as sensitive personal information everywhere in the system. This document describes controls that exist in code today; it makes no legal-compliance claim on behalf of any tenant. Each tenant configures its own lawful basis, notices and retention policy.

## Data categories and their handling

**Capture media (selfie frames).** Analysed in memory by the provider boundary and discarded. Default retention is zero — there is no code path that stores a capture image unless tenant policy explicitly retains evidence (below). Uploads are limited to 8 MiB, validated by MIME magic bytes, and pass a malware-scan adapter.

**Biometric templates.** Only opaque AES-256-GCM ciphertext produced inside the provider boundary is stored (`reference_templates.template_ciphertext`). The platform cannot decrypt or reverse them. Encryption keys are per-tenant DEKs wrapped by a KMS/HSM master key; production refuses to boot on a dev key configuration. On deletion the ciphertext column is overwritten, not just flagged.

**Evidence media (optional).** Exists only when a tenant explicitly retains it, and every object requires a purpose and a future retention expiry. Objects are envelope-encrypted, have no public URLs, are accessible only to reviewer-permission roles (audited on every access), and are deleted by the retention sweep at expiry.

**Verification events.** Scores, decision, reason code, policy version and model identity — no images, no embeddings. Consent receipts record notice version, purpose, lawful-basis field, withdrawal state and retention expiry.

**Secrets.** Webhook signing secrets and TOTP seeds are envelope-encrypted at rest with context-bound AAD; API keys and session tokens are stored only as SHA-256 hashes; all are shown exactly once at creation.

**Logs and audit.** The structured logger redacts by default (there is no unredacted mode) and the audit writer refuses biometric/secret material structurally. IP addresses appear only as salted hashes. Tests prove capture payloads never reach logs, audit events or ordinary columns (`tests/privacy.test.ts`, leakage proofs).

## Subject rights

Export (`exportSubjectData`) returns everything held about a subject except biometric material, which is excluded by design. Deletion (`deleteSubjectData`) revokes templates (destroying ciphertext), withdraws consents, deletes retained evidence and blocks all future matching. An active legal hold parks the request as `blocked_legal_hold` — visible on the security dashboard — rather than silently skipping it. The deletion itself is audited with counts only.

Consent withdrawal via `POST /v1/consents/:id/withdraw` is idempotent, revokes the linked templates and notifies the tenant by signed webhook.

## Residency and transfers

Each tenant records its country and storage region in `data_residency`. Any cross-border movement of templates, evidence or exports must be entered in `transfer_register` first, with data category, regions, safeguard mechanism, reason and a named approver. No code path moves data between regions implicitly.

## Retention summary

| Data | Default | Configurable |
|---|---|---|
| Capture media | Deleted after analysis (zero retention) | Evidence retention with purpose + expiry |
| Templates | Until consent withdrawal, deletion or expiry | Template expiry date |
| Consent receipts | Retained as legal evidence | Tenant retention expiry field |
| Verification events | Retained (scores/reasons only) | Tenant archive policy (Prompt 6 job) |
| Audit chain | Append-only, retained | WORM export (Prompt 6) |
| Idempotency keys / capture sessions | Short-lived operational data | Sweep job (Prompt 6) |
