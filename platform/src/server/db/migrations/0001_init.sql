-- BioCheck platform — foundation schema (Prompt 1)
-- Append-only audit, strict tenancy, no biometric columns anywhere in this schema.

CREATE TABLE organisations (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

CREATE TABLE projects (
  id              UUID PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id),
  organisation_id UUID NOT NULL REFERENCES organisations(id), -- denormalised for isolation checks
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE environments (
  id         UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  kind       TEXT NOT NULL CHECK (kind IN ('sandbox','production')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind)
);

CREATE TABLE users (
  id                  UUID PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  email_verified_at   TIMESTAMPTZ,
  password_hash       TEXT NOT NULL,          -- scrypt, versioned format
  password_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  totp_secret_enc     TEXT,                   -- encrypted at rest; null = MFA not enrolled
  mfa_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  platform_role       TEXT CHECK (platform_role IN ('platform_super_admin','platform_security_admin')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL CHECK (role IN (
    'organisation_owner','organisation_admin','compliance_officer',
    'integration_developer','reviewer','analyst','read_only')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id)
);

CREATE TABLE sessions (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id),
  token_hash   TEXT NOT NULL UNIQUE,        -- sha256 of the bearer token; raw token never stored
  rotated_from UUID,
  ip_hash      TEXT,                        -- privacy-minimised (salted hash), never raw IP
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);

CREATE TABLE recovery_codes (
  id        UUID PRIMARY KEY,
  user_id   UUID NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at   TIMESTAMPTZ
);

CREATE TABLE invitations (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  email           TEXT NOT NULL,
  role            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  invited_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

-- Enterprise SSO placeholder: connection metadata only. Clearly labelled
-- Enterprise-plan feature; no live IdP wiring in local development.
CREATE TABLE sso_connections (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  kind            TEXT NOT NULL CHECK (kind IN ('saml','oidc')),
  label           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'placeholder' CHECK (status IN ('placeholder','configured','active','disabled')),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id             UUID PRIMARY KEY,
  project_id     UUID NOT NULL REFERENCES projects(id),
  environment_id UUID NOT NULL REFERENCES environments(id),
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  name           TEXT NOT NULL,
  prefix         TEXT NOT NULL UNIQUE,       -- public identifier, e.g. bck_sandbox_ab12
  key_hash       TEXT NOT NULL,              -- sha256(secret); secret shown once, never stored
  scopes         TEXT[] NOT NULL,
  created_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

CREATE TABLE ip_allowlist (
  id              UUID PRIMARY KEY,
  organisation_id UUID NOT NULL REFERENCES organisations(id),
  project_id      UUID REFERENCES projects(id),
  cidr            TEXT NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  seq             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  organisation_id UUID,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  actor_id        TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  request_id      TEXT,
  ip_minimised    TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('success','denied','failure')),
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- redaction-guarded before insert
  previous_hash   TEXT NOT NULL,
  event_hash      TEXT NOT NULL UNIQUE
);

CREATE INDEX audit_events_org_time ON audit_events (organisation_id, occurred_at DESC);
CREATE INDEX audit_events_action ON audit_events (action);

-- Append-only enforcement: any UPDATE or DELETE on audit_events is refused.
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
