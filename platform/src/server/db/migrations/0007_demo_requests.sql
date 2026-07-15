-- Phase 6: qualified demo-request lead capture for the marketing site.
-- Deliberately minimal PII: name, work email, organisation and free-text
-- context, stored only with explicit consent to be contacted. No tracking
-- identifiers, no enrichment. IP is stored only as a salted hash for abuse
-- control and is never shown in any UI.

CREATE TABLE demo_requests (
  id                   UUID PRIMARY KEY,
  full_name            TEXT NOT NULL,
  work_email           TEXT NOT NULL,
  organisation         TEXT NOT NULL,
  sector               TEXT NOT NULL CHECK (sector IN (
                         'healthcare','insurance','government','workforce',
                         'financial-services','elections','education',
                         'telecommunications','other')),
  country              TEXT,
  message              TEXT,
  consented_to_contact BOOLEAN NOT NULL,
  source_path          TEXT,
  ip_hash              TEXT,
  status               TEXT NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new','contacted','qualified','closed')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at           TIMESTAMPTZ,
  handled_by           TEXT
);

CREATE INDEX demo_requests_status_time ON demo_requests (status, created_at DESC);
