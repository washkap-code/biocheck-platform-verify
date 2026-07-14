-- BioCheck platform — background job framework (Prompt 6)
-- Idempotent jobs with retry state and dead-letter visibility.

CREATE TABLE jobs (
  id           UUID PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   TEXT UNIQUE,                -- idempotent scheduling
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','succeeded','failed','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error   TEXT,                        -- sanitised message only
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX jobs_due ON jobs (status, next_run_at);

-- Append-only WORM export bookkeeping for the audit chain.
CREATE TABLE audit_exports (
  id          UUID PRIMARY KEY,
  from_seq    BIGINT NOT NULL,
  to_seq      BIGINT NOT NULL,
  head_hash   TEXT NOT NULL,               -- chain head at export time
  storage_ref TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
