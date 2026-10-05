CREATE TABLE oauth_provider_settings (
  provider text PRIMARY KEY CHECK (provider IN ('github','linuxdo')),
  overridden boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  client_id varchar(512) NOT NULL DEFAULT '',
  client_secret_ciphertext text,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- An untouched row follows environment credentials, preserving existing installs.
-- The first administrator configuration becomes a complete database override.
INSERT INTO oauth_provider_settings(provider) VALUES ('github'),('linuxdo');
ALTER TABLE oauth_states ADD COLUMN config_fingerprint text;
CREATE INDEX oauth_states_provider_idx ON oauth_states(provider);
-- States created before configuration fingerprints cannot safely be reused.
DELETE FROM oauth_states;
