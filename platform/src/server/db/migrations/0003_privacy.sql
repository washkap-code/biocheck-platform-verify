-- BioCheck platform — privacy, encryption and retention (Prompt 3)

-- Per-tenant data-encryption keys, wrapped by the KMS master key.
-- The plaintext DEK exists only in process memory; never in this table.
CREATE TABLE tenant_keys (
  id              UUID PRIMARY KEY,
  organisation_id UUID REFERENCES organisations(id),  -- NULL = platform scope (e.g. user TOTP secrets)
  key_version     INTEGER NOT NULL,
  wrapped_dek     TEXT NOT NULL,            -- KMS-wrapped, base64
  kms_key_ref     TEXT NOT NULL,            -- which master key wrapped it
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotating','retired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotate_due_at   TIMESTAMPTZ NOT NULL,     -- rotation reminder surface
  retired_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX tenant_keys_org_version ON tenant_keys (COALESCE(organisation_id, '00000000-0000-0000-0000-000000000000'::uuid), key_version);

-- Optional encrypted evidence media. DEFAULT RETENTION IS ZERO — a row exists
-- only when tenant policy explicitly retains evidence, with purpose + expiry.
CREATE TABLE evidence_objects (
  id                   UUID PRIMARY KEY,
  organisation_id      UUID NOT NULL REFERENCES organisations(id),
  subject_id           UUID REFERENCES subjects(id),
  related_type         TEXT NOT NULL,       -- e.g. verification_attempt, review_case
  related_id           UUID,
  purpose              TEXT NOT NULL,       -- mandatory: why this is retained
  retention_expires_at TIMESTAMPTZ NOT NULL,
  storage_ref          TEXT NOT NULL,       -- opaque key in the storage adapter; NEVER a public URL
  content_sha256       TEXT NOT NULL,
  key_version          INTEGER NOT NULL,
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX evidence_retention_due ON evidence_objects (retention_expires_at) WHERE deleted_at IS NULL;

-- Subject rights: export and deletion/withdrawal workflow with legal hold.
CREATE TABLE subject_requests (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  subject_id      UUID NOT NULL REFERENCES subjects(id),
  kind            TEXT NOT NULL CHECK (kind IN ('export','deletion')),
  status          TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_progress','blocked_legal_hold','completed','rejected')),
  legal_hold_ref  TEXT,                      -- populated when a hold blocks deletion
  requested_via   TEXT NOT NULL,             -- api_key / console user id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

-- Active legal holds per subject (tenant-configurable, auditable).
CREATE TABLE legal_holds (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  subject_id      UUID NOT NULL REFERENCES subjects(id),
  reason          TEXT NOT NULL,
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at     TIMESTAMPTZ
);

-- Data residency metadata and cross-border transfer register.
CREATE TABLE data_residency (
  organisation_id UUID PRIMARY KEY REFERENCES organisations(id),
  country_code    TEXT NOT NULL,             -- ISO 3166-1 alpha-2 of the tenant
  storage_region  TEXT NOT NULL,             -- where templates/evidence live
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transfer_register (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  data_category   TEXT NOT NULL,             -- e.g. templates, evidence, audit_export
  from_region     TEXT NOT NULL,
  to_region       TEXT NOT NULL,
  mechanism       TEXT NOT NULL,             -- tenant-configured safeguard reference
  reason          TEXT NOT NULL,
  approved_by     UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
