-- BioCheck platform — document verification, review operations, fraud (Prompt 4)
-- Rule preserved everywhere: full identity-document numbers are NEVER stored,
-- logged or placed in URLs. Only masked forms and check outcomes persist.

CREATE TABLE document_checks (
  id                 UUID PRIMARY KEY,
  organisation_id    UUID NOT NULL REFERENCES organisations(id),
  project_id         UUID NOT NULL REFERENCES projects(id),
  subject_id         UUID REFERENCES subjects(id),
  capture_session_id UUID REFERENCES capture_sessions(id),
  provider_id        TEXT NOT NULL,
  -- staged outcomes; each is pass / warn / fail / skipped
  stage_capture_quality TEXT NOT NULL,
  stage_classification  TEXT NOT NULL,
  stage_ocr_mrz         TEXT NOT NULL,
  stage_expiry          TEXT NOT NULL,
  stage_tamper          TEXT NOT NULL,
  stage_portrait        TEXT NOT NULL,
  -- minimised extracted fields only
  document_class     TEXT,                    -- e.g. passport, national_id, driver_licence, unknown
  issuing_country    TEXT,                    -- ISO alpha-2
  doc_number_masked  TEXT,                    -- e.g. ****1234 — full number never stored
  expiry_date        DATE,
  tamper_signals     TEXT[] NOT NULL DEFAULT '{}',
  overall            TEXT NOT NULL CHECK (overall IN ('pass','review','fail')),
  reason_code        TEXT NOT NULL,
  evidence_id        UUID,                    -- encrypted evidence object (optional, tenant policy)
  audit_hash         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_checks_org_time ON document_checks (organisation_id, created_at DESC);

-- Review operations: risk, SLA and dual control.
ALTER TABLE review_cases ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'standard'
  CHECK (risk_level IN ('standard','high'));
ALTER TABLE review_cases ADD COLUMN sla_due_at TIMESTAMPTZ;
ALTER TABLE review_cases ADD COLUMN requires_dual_control BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE review_cases ADD COLUMN first_approval_by UUID REFERENCES users(id);
ALTER TABLE review_cases ADD COLUMN first_approval_outcome TEXT;
ALTER TABLE review_cases ADD COLUMN first_approval_reason TEXT;
ALTER TABLE review_cases ADD COLUMN first_approval_at TIMESTAMPTZ;
ALTER TABLE review_cases ADD COLUMN evidence_id UUID;

-- Tenant-level exception policy switches (explicit, auditable configuration).
CREATE TABLE org_settings (
  organisation_id UUID PRIMARY KEY REFERENCES organisations(id),
  -- A rejected LIVENESS_FAILED outcome may be escalated to a dual-control
  -- review ONLY when this is true. Default false: liveness failures are final.
  allow_liveness_exception BOOLEAN NOT NULL DEFAULT FALSE,
  review_sla_minutes INTEGER NOT NULL DEFAULT 240,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Device / app attestation results (adapter-produced; no device fingerprint PII).
CREATE TABLE device_attestations (
  id                 UUID PRIMARY KEY,
  organisation_id    UUID NOT NULL REFERENCES organisations(id),
  capture_session_id UUID NOT NULL REFERENCES capture_sessions(id),
  adapter_id         TEXT NOT NULL,
  verdict            TEXT NOT NULL CHECK (verdict IN ('trusted','untrusted','unknown')),
  signals            TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Risk signals: inputs to review routing. NEVER protected-trait inference,
-- NEVER social/credit/health decisions — routing to human review only.
CREATE TABLE risk_signals (
  id                 UUID PRIMARY KEY,
  organisation_id    UUID NOT NULL REFERENCES organisations(id),
  subject_id         UUID REFERENCES subjects(id),
  capture_session_id UUID REFERENCES capture_sessions(id),
  kind               TEXT NOT NULL,           -- velocity_anomaly | duplicate_capture | attestation_untrusted | ...
  severity           TEXT NOT NULL CHECK (severity IN ('info','elevated','high')),
  detail             JSONB NOT NULL DEFAULT '{}'::jsonb,   -- redaction-guarded
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_signals_org_time ON risk_signals (organisation_id, created_at DESC);
