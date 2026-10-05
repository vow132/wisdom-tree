-- The repository credential is purpose-bound AES-GCM ciphertext. It is never
-- included in public settings, administrator responses or audit snapshots.
CREATE TABLE system_update_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  enabled boolean NOT NULL DEFAULT false,
  token_ciphertext text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_update_settings(id) VALUES(true);
CREATE TABLE system_update_jobs (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  target_sha text NOT NULL CHECK(target_sha ~ '^[a-f0-9]{40}$'),
  status text NOT NULL CHECK(status IN ('dispatching','submitted','failed','finished')),
  run_id text,
  run_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A database constraint protects all API processes and concurrent browser tabs.
CREATE UNIQUE INDEX system_update_single_active ON system_update_jobs((true))
  WHERE status IN ('dispatching','submitted');
