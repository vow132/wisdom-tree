CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned','deleted')),
  coins bigint NOT NULL DEFAULT 0 CHECK (coins >= 0 AND coins <= 9007199254740991),
  fertilizer integer NOT NULL DEFAULT 0 CHECK (fertilizer >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trees (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  seed_claimed boolean NOT NULL DEFAULT false,
  planted boolean NOT NULL DEFAULT false,
  height bigint NOT NULL DEFAULT 0 CHECK (height >= 0 AND height <= 9007199254740991),
  CHECK (NOT planted OR seed_claimed)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE identities (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK (provider IN ('github','linuxdo')),
  provider_user_id text NOT NULL, display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_user_id), UNIQUE(user_id,provider)
);
CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY, provider text NOT NULL,
  bind_user_id uuid REFERENCES users(id), session_hash text,
  verifier text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  rules jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings(id,rules) VALUES(true,'{"dailyFertilizer":5,"inventoryLimit":10,"coinsPerFeed":10,"growthPerFeed":1,"apiRateLimit":60}');
CREATE TABLE daily_claims (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  claim_date date NOT NULL, amount integer NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,claim_date)
);
CREATE TABLE ledger (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL, coins_delta bigint NOT NULL DEFAULT 0,
  fertilizer_delta integer NOT NULL DEFAULT 0, reason text NOT NULL,
  reference_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_reference_idx ON ledger(reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX ledger_user_time_idx ON ledger(user_id,created_at DESC);
CREATE TABLE game_actions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  endpoint text NOT NULL, idem_key text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,endpoint,idem_key)
);
CREATE TABLE api_keys (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL, prefix text NOT NULL, key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz
);
CREATE INDEX api_keys_user_idx ON api_keys(user_id);
CREATE TABLE models (
  id text PRIMARY KEY, display_name text NOT NULL,
  coins_per_call integer NOT NULL CHECK (coins_per_call >= 0),
  enabled boolean NOT NULL DEFAULT true, reply_text text NOT NULL,
  stream_chunk_chars integer NOT NULL DEFAULT 8 CHECK (stream_chunk_chars BETWEEN 1 AND 1000),
  stream_delay_ms integer NOT NULL DEFAULT 20 CHECK (stream_delay_ms BETWEEN 0 AND 1000),
  deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO models(id,display_name,coins_per_call,reply_text) VALUES
('gpt-5.6-luna','Luna · 假 AI',1,'智慧树说：每天照料一点，耐心就会发芽。'),
('gpt-5.6-sol','Sol · 假 AI',2,'智慧树说：每天照料一点，耐心就会发芽。'),
('claude-sonnet-4-6','Sonnet · 假 AI',5,'智慧树说：每天照料一点，耐心就会发芽。');
CREATE TABLE api_requests (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  api_key_id uuid NOT NULL REFERENCES api_keys(id), model_id text NOT NULL REFERENCES models(id),
  endpoint text NOT NULL, request_hash text NOT NULL, idem_key text,
  coins_charged bigint NOT NULL CHECK (coins_charged >= 0),
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','completed','disconnected')),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_requests_idem_idx ON api_requests(user_id,endpoint,idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX api_requests_user_time_idx ON api_requests(user_id,created_at DESC);
CREATE TABLE audit (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), actor_name text NOT NULL,
  action text NOT NULL, target_id text NOT NULL, reason text NOT NULL,
  before_value jsonb, after_value jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit(created_at DESC);
CREATE TABLE admin_guard (id boolean PRIMARY KEY CHECK(id));
INSERT INTO admin_guard(id) VALUES(true);
