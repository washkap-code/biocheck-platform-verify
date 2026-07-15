-- Fingerprint modality. Mirrors the face pipeline: opaque templates only,
-- immutable decision policies, modality-tagged so a fingerprint template can
-- never be matched against a face capture or vice versa.
--
-- HONESTY NOTE: no production fingerprint capture or matching exists yet
-- (see docs/FINGERPRINT_BUILD_STATUS.md). This schema is the contract the
-- real scanner sidecar will plug into; every path fails closed until then.

ALTER TABLE capture_sessions
  ADD COLUMN modality TEXT NOT NULL DEFAULT 'face'
  CHECK (modality IN ('face','fingerprint'));

ALTER TABLE reference_templates
  ADD COLUMN modality TEXT NOT NULL DEFAULT 'face'
  CHECK (modality IN ('face','fingerprint'));

ALTER TABLE verification_attempts
  ADD COLUMN modality TEXT NOT NULL DEFAULT 'face'
  CHECK (modality IN ('face','fingerprint'));

CREATE INDEX reference_templates_subject_modality
  ON reference_templates (subject_id, modality, status);

-- Immutable fingerprint decision policies (same governance as
-- verification_policies: insert-only, enforced by trigger).
CREATE TABLE fingerprint_policies (
  id                       UUID PRIMARY KEY,
  organisation_id          UUID REFERENCES organisations(id), -- NULL = platform default
  name                     TEXT NOT NULL,
  version                  INTEGER NOT NULL,
  min_quality              REAL NOT NULL,
  min_minutiae             INTEGER NOT NULL,
  approve_score            REAL NOT NULL,
  review_score             REAL NOT NULL,
  -- Fingerprint PAD depends on capture hardware; approvals without a live
  -- PAD result are capped at human review while this is TRUE (default).
  require_pad_for_approval BOOLEAN NOT NULL DEFAULT TRUE,
  approved_by              TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name, version)
);

CREATE TRIGGER fingerprint_policies_immutable
  BEFORE UPDATE OR DELETE ON fingerprint_policies
  FOR EACH ROW EXECUTE FUNCTION forbid_policy_mutation();

ALTER TABLE environments
  ADD COLUMN active_fp_policy_id UUID REFERENCES fingerprint_policies(id);

-- Fingerprint attempts reference their fingerprint policy (the existing
-- policy_id column references face verification_policies and stays NULL
-- for fingerprint attempts).
ALTER TABLE verification_attempts
  ADD COLUMN fp_policy_id UUID REFERENCES fingerprint_policies(id);
