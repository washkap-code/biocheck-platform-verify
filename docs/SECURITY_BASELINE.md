# BioCheck security baseline (Prompt 1)

What is enforced in code today, where, and how it is tested. Claims here are limited to what the test suite demonstrates (`platform/tests/foundation.test.ts`, 20 passing; `tests/test_engine.py`, 8 passing).

## Tenancy and authorisation

- Hierarchy: organisation → workspace → project → environments (sandbox/production). Projects carry a denormalised `organisation_id` so isolation checks never depend on joins alone.
- One policy layer: `src/server/authz/policy.ts#authorize()`. No role checks anywhere else. Client-supplied organisation IDs are never trusted; membership is resolved server-side on every call. Tested: cross-tenant reads and writes are refused; cross-org workspace/project attachment is refused.
- Roles: platform_super_admin (full, always audited), platform_security_admin (read/audit oversight only), organisation_owner, organisation_admin, compliance_officer, integration_developer, reviewer, analyst, read_only. Permission matrix lives in one table in code.

## Authentication and account controls

- Passwords: scrypt (N=2^15, r=8, p=1), per-user salt, versioned format; ≥12 chars, common-password and email-derivative rejection. Verified email required before login.
- Lockout: 5 failed attempts → 15-minute lock (tested).
- Sessions: opaque 256-bit tokens, stored as SHA-256 only, 12 h expiry, rotation endpoint revokes the predecessor atomically (tested). IPs stored only as salted hashes.
- MFA: TOTP (RFC 6238) with ±1 window drift; 8 single-use recovery codes stored hashed. Privileged roles (both platform roles, organisation_owner, organisation_admin) cannot obtain a session without MFA (tested). TOTP secret is stored in the column reserved for KMS-encrypted ciphertext; envelope encryption lands in Prompt 3 and is tracked as an open item below.
- Invitations: 7-day expiry, single use, hashed token, bound to the invited email (tested). SSO/SAML: schema placeholder only, clearly labelled Enterprise-plan; no live IdP wiring.

## API keys

- Per project + environment, format `bck_<env>_<prefix>.<secret>`; secret shown once, stored as SHA-256. Explicit scopes from a fixed vocabulary; scope misses are denied AND audited (tested). Environment binding, revocation and expiry enforced (tested). IP allow-list table present; enforcement wiring arrives with the public API in Prompt 2.

## Audit

- Append-only at the database level: UPDATE/DELETE on `audit_events` raise via trigger (tested).
- Hash chain: sha256(previous_hash + canonical JSON) — the same construction as the Python engine, so platform and verify-core evidence can be verified with one tool. Chain verification tested.
- Redaction guard: audit details refuse keys matching biometric/secret patterns and values that look like media/key blobs, at write time (tested). No raw images, embeddings, tokens, ID numbers in any audit event — structurally, not by convention.
- Viewer: `/admin/audit` role-guarded via audit:read; CSV export requires audit:export; export contains no secret columns (tested).

## Known open items (tracked, not hidden)

1. TOTP secret and API-key material encryption-at-rest via KMS envelope — Prompt 3.
2. Rate limiting on auth endpoints beyond lockout (per-IP throttling) — Prompt 2/3 with Redis abstraction.
3. IP allow-list enforcement on the public API — Prompt 2.
4. CSP/security headers, CSRF strategy for the console — Prompt 3.
5. SeetaFace6 native sidecar binary: cannot be compiled in this hosted workspace (long builds are terminated). Must be built on the designated Linux builder per `docs/SEETAFACE6_BUILD_STATUS.md`.

## Rules that never relax

No 1:N search or surveillance features. No raw biometric material in logs, URLs, analytics, audit or unencrypted columns. Fail closed on liveness failure, unknown model hash or inference outage. No certification/accuracy marketing claims. Production deployment stays manually gated (Prompt 7 + human approvals).
