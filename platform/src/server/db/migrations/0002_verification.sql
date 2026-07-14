-- BioCheck platform — verification domain (Prompt 2)
-- Consent-led 1:1 verification only. No raw biometric material in any column:
-- reference_templates.template_ciphertext is opaque AES-256-GCM ciphertext
-- produced inside the provider boundary (verify-core), never plaintext.

CREATE TABLE subjects (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  project_id      UUID NOT NULL REFERENCES projects(id),
  subject_ref     TEXT NOT NULL,             -- tenant-supplied opaque reference (never an ID number)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, subject_ref)
);

CREATE TABLE consent_receipts (
  id                   UUID PRIMARY KEY,
  organisation_id      UUID NOT NULL REFERENCES organisations(id),
  subject_id           UUID NOT NULL REFERENCES subjects(id),
  notice_version       TEXT NOT NULL,        -- versioned notice shown to the person
  purpose              TEXT NOT NULL,
  lawful_basis         TEXT NOT NULL,        -- tenant-configured; the platform makes no legal conclusion
  captured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at         TIMESTAMPTZ,
  retention_expires_at TIMESTAMPTZ,
  evidence_ref         TEXT,                 -- pointer into governed evidence store; never media itself
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable, versioned decision policies. New thresholds = new row + repoint.
CREATE TABLE verification_policies (
  id                  UUID PRIMARY KEY,
  organisation_id     UUID REFERENCES organisations(id),  -- NULL = platform default
  name                TEXT NOT NULL,
  version             INTEGER NOT NULL,
  min_quality         REAL NOT NULL,
  max_pose_degrees    REAL NOT NULL,
  max_occlusion       REAL NOT NULL,
  min_liveness        REAL NOT NULL,
  approve_similarity  REAL NOT NULL,
  review_similarity   REAL NOT NULL,
  required_checks     JSONB NOT NULL DEFAULT '["quality","liveness","similarity"]'::jsonb,
  approved_by         TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name, version)
);

CREATE OR REPLACE FUNCTION forbid_policy_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'verification_policies is immutable; create a new version instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER verification_policies_no_update BEFORE UPDATE ON verification_policies
  FOR EACH ROW EXECUTE FUNCTION forbid_policy_mutation();
CREATE TRIGGER verification_policies_no_delete BEFORE DELETE ON verification_policies
  FOR EACH ROW EXECUTE FUNCTION forbid_policy_mutation();

ALTER TABLE environments ADD COLUMN active_policy_id UUID REFERENCES verification_policies(id);

-- Short-lived, one-use, nonce-bound capture sessions. Stores no image.
CREATE TABLE capture_sessions (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  project_id      UUID NOT NULL REFERENCES projects(id),
  environment_id  UUID NOT NULL REFERENCES environments(id),
  purpose         TEXT NOT NULL CHECK (purpose IN ('enrolment','verification')),
  subject_id      UUID REFERENCES subjects(id),
  token_hash      TEXT NOT NULL UNIQUE,      -- sha256 of the signed client token
  nonce           TEXT NOT NULL,             -- active-challenge binding
  challenge       TEXT NOT NULL,             -- random challenge instruction id
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','expired','cancelled')),
  api_key_id      UUID REFERENCES api_keys(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ
);

CREATE TABLE reference_templates (
  id                  UUID PRIMARY KEY,
  organisation_id     UUID NOT NULL REFERENCES organisations(id),
  project_id          UUID NOT NULL REFERENCES projects(id),
  subject_id          UUID NOT NULL REFERENCES subjects(id),
  consent_receipt_id  UUID NOT NULL REFERENCES consent_receipts(id),
  template_ciphertext TEXT NOT NULL,         -- opaque; encrypted inside the provider boundary
  model_id            TEXT NOT NULL,
  model_sha256        TEXT NOT NULL,
  source_type         TEXT NOT NULL CHECK (source_type IN ('live_capture','document_portrait')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at          TIMESTAMPTZ
);
CREATE INDEX reference_templates_subject ON reference_templates (subject_id, status);

CREATE TABLE verification_attempts (
  id                 UUID PRIMARY KEY,
  organisation_id    UUID NOT NULL REFERENCES organisations(id),
  project_id         UUID NOT NULL REFERENCES projects(id),
  environment_id     UUID NOT NULL REFERENCES environments(id),
  subject_id         UUID NOT NULL REFERENCES subjects(id),
  capture_session_id UUID NOT NULL REFERENCES capture_sessions(id),
  decision           TEXT NOT NULL CHECK (decision IN ('approved','review','rejected')),
  reason_code        TEXT NOT NULL,
  human_message      TEXT NOT NULL,
  similarity         REAL,
  liveness_score     REAL,
  quality_score      REAL,
  model_id           TEXT,
  model_sha256       TEXT,
  policy_id          UUID REFERENCES verification_policies(id),
  policy_version     INTEGER,
  audit_hash         TEXT NOT NULL,
  request_id         TEXT,
  api_key_id         UUID REFERENCES api_keys(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX verification_attempts_org_time ON verification_attempts (organisation_id, created_at DESC);

CREATE TABLE review_cases (
  id                      UUID PRIMARY KEY,
  organisation_id         UUID NOT NULL REFERENCES organisations(id),
  verification_attempt_id UUID NOT NULL UNIQUE REFERENCES verification_attempts(id),
  reason_code_at_open     TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected')),
  decided_by              UUID REFERENCES users(id),   -- named human reviewer, mandatory at decision
  decided_reason          TEXT,
  decided_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Persistent approved-model registry (mirror of verify-core's admission gate).
CREATE TABLE model_registry (
  id                      UUID PRIMARY KEY,
  model_id                TEXT NOT NULL,
  sha256                  TEXT NOT NULL,
  purpose                 TEXT NOT NULL,
  commercial_use_approved BOOLEAN NOT NULL,
  independent_report_ref  TEXT NOT NULL,
  approved_by             TEXT NOT NULL,
  expires_on              DATE NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, sha256, purpose)
);

CREATE TABLE webhook_endpoints (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  project_id      UUID NOT NULL REFERENCES projects(id),
  environment_id  UUID NOT NULL REFERENCES environments(id),
  url             TEXT NOT NULL,
  -- Tenant-specific signing secret. Held in the column reserved for KMS
  -- ciphertext; envelope encryption lands in Prompt 3.
  secret_enc      TEXT NOT NULL,
  events          TEXT[] NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              UUID PRIMARY KEY,
  endpoint_id     UUID NOT NULL REFERENCES webhook_endpoints(id),
  event_id        UUID NOT NULL,             -- consumer-side replay dedupe key
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);

CREATE TABLE idempotency_keys (
  id              UUID PRIMARY KEY,
  api_key_id      UUID NOT NULL REFERENCES api_keys(id),
  endpoint        TEXT NOT NULL,
  idem_key        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, endpoint, idem_key)
);
