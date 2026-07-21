# Per-tenant KMS keys + rotation — build status

**Last updated:** 22 Jul 2026
**Honest status:** a real AWS KMS adapter and a real key-rotation-execution
job now exist, both covered by passing tests. Neither has ever been run
against a live AWS account — this environment has no AWS credentials. The
adapter logic and the rotation job's database behaviour are proven; the
"does this actually work against a real AWS KMS key, IAM policy and network
path" question is not, and can't be answered from inside this sandbox.

## 22 Jul 2026 — AwsKmsAdapter + keys.rotation_execute built and tested

**What existed before this session:** `platform/src/server/security/kms.ts`
already had a complete `KmsAdapter` interface, a dev-only `LocalKmsAdapter`,
per-tenant DEK issuance/rotation functions (`getTenantDek`,
`rotateTenantDek`, `getTenantDekVersion`), AES-256-GCM envelope helpers, and
`assertProductionKeyConfig()` (production refuses to boot on the local
adapter). Two gaps made this non-functional for a real deployment:

1. **No real KMS adapter existed.** The interface had one implementer —
   the dev-only local one — so there was nothing for a production
   deployment to actually configure.
2. **`setKms()` was never called anywhere.** Grepping the codebase
   confirmed it: the only way to install a non-default adapter was to call
   a function nothing invoked. `getKms()` always built a fresh
   `LocalKmsAdapter`, which `assertProductionKeyConfig` would then correctly
   refuse in production — meaning production had no path to boot with any
   KMS at all, dev-adapter or otherwise.
3. **Rotation was reminder-only.** `keys.rotation_reminder` audited overdue
   keys (`key.rotation_overdue`) but never actually rotated anything —
   there was no code path that called `rotateTenantDek()` on a schedule.

**What was built:**

- `platform/src/server/security/kms-aws.ts` — `AwsKmsAdapter`, a real
  `KmsAdapter` implementation using `@aws-sdk/client-kms`'s
  `EncryptCommand`/`DecryptCommand`. `keyRef` is the real KMS key ARN/ID
  (never `local-dev`-prefixed), so `assertProductionKeyConfig` accepts it.
  Accepts an injectable `KMSClient` for testing; production wiring lets the
  SDK build its own client from ambient AWS credentials.
- `kms.ts`'s `getKms()` is now env-driven: `BIOCHECK_KMS_PROVIDER=aws` (+
  `BIOCHECK_KMS_KEY_ID`, optional `AWS_REGION`) builds a real
  `AwsKmsAdapter`; anything else falls back to `LocalKmsAdapter`, which
  production still refuses to boot on. This closes the wiring gap —
  there is now an actual path from environment configuration to a real
  adapter, not just an unused `setKms()` function.
- `config.ts` now refuses to start **production** unless
  `BIOCHECK_KMS_PROVIDER=aws` and `BIOCHECK_KMS_KEY_ID` are both set (staging
  is unaffected — it may still run on the local adapter with an env master
  key, as before).
- `maintenance.ts` adds `keys.rotation_execute`, a new recurring job
  (daily, alongside the unchanged `keys.rotation_reminder`) that actually
  calls `rotateTenantDek()` for every tenant key past its `rotate_due_at`,
  retiring the old version and auditing `key.rotation_executed` with the
  previous and new key versions. It is idempotent by construction: a
  rotated key's new `rotate_due_at` is 180 days out, so it does not
  reappear in the next run's overdue query.

**Test evidence:**
- `tests/kms-aws.test.ts` (new, 9/9 passing): keyId validation, wrap/unwrap
  request shapes against a mocked `KMSClient` (asserts the actual
  `EncryptCommand`/`DecryptCommand` inputs sent), a round-trip through an
  in-memory fake KMS, missing-ciphertext/missing-plaintext refusals, a
  wrong-length-DEK refusal, and that client errors (e.g.
  `AccessDeniedException`) propagate unchanged.
- `tests/operations.test.ts` (extended): `prodBase` now includes
  `BIOCHECK_KMS_PROVIDER`/`BIOCHECK_KMS_KEY_ID`; new assertions confirm
  production refuses to start without a real provider or without a key id;
  staging's exemption is confirmed unaffected. A new test creates a tenant
  key, marks it overdue, runs `keys.rotation_execute`, and confirms: the
  active key version actually increased, the old version is now `retired`,
  `key.rotation_executed` was audited with before/after versions, and a
  second immediate run does nothing further (the new key isn't overdue
  yet) — proving the rotation is real and idempotent, not just a flag.
- Full platform suite re-run clean after these changes: 158/158 vitest
  across all 11 test files (`kms-aws`, `operations`, `adversarial`,
  `context`, `documents`, `fingerprint`, `flows.e2e`, `foundation`, `leads`,
  `privacy`, `verification`), plus `tsc --noEmit` clean.

**Classification (reality-matrix discipline):** per-tenant KMS keys +
rotation move from "interface + dev adapter only, no rotation execution, no
wiring to a real provider" to **"Prototype (AWS adapter + rotation-execution
job built, unit/integration-tested against mocks and a real Postgres-backed
job queue; never exercised against a live AWS account)."** This is not
Production. What's still outstanding, unchanged by this session:

1. **A real AWS account and KMS key.** Create the key, scope an IAM policy
   to exactly `kms:Encrypt`/`kms:Decrypt`/`kms:DescribeKey` on that key for
   the deployment's role, and set `BIOCHECK_KMS_PROVIDER=aws` +
   `BIOCHECK_KMS_KEY_ID` (+ `AWS_REGION`) in the real production
   environment.
2. **A live smoke test.** Before cutting over any tenant traffic: wrap and
   unwrap a real DEK against the real key, confirm CloudTrail shows the
   Encrypt/Decrypt calls, and confirm rotation executes correctly against
   the real key (KMS-side key rotation, if enabled, is a separate AWS
   feature from this application-level DEK rotation and should be reasoned
   about explicitly, not assumed compatible).
3. **Alerting on rotation.** `key.rotation_executed` and
   `key.rotation_overdue` are audited but not yet wired to any external
   alert (e.g. the webhook system already used for `model.status_changed`
   could carry a `key.rotation_executed` event if that's wanted — not
   built here, since it wasn't asked for and the audit trail already
   covers the requirement).
4. **Multi-region / disaster-recovery story for the KMS key itself** is an
   operator decision (AWS multi-region keys vs. single-region) not made or
   assumed here.
