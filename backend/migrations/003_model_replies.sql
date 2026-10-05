CREATE TABLE model_replies (
  id uuid PRIMARY KEY,
  model_id text NOT NULL REFERENCES models(id) ON UPDATE CASCADE,
  position integer NOT NULL CHECK (position >= 1 AND position <= 1000000),
  text text NOT NULL CHECK (length(text) >= 1 AND length(text) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(model_id,position)
);
CREATE TABLE model_reply_cursors (
  user_id uuid NOT NULL REFERENCES users(id),
  model_id text NOT NULL REFERENCES models(id) ON UPDATE CASCADE,
  last_reply_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,model_id)
);
-- Existing single-response models start with a one-entry reply pool.
INSERT INTO model_replies(id,model_id,position,text)
SELECT gen_random_uuid(),id,1,reply_text FROM models WHERE deleted_at IS NULL;
INSERT INTO models(id,display_name,coins_per_call,enabled,reply_text,stream_chunk_chars,stream_delay_ms)
VALUES('wisdom-tree','智慧树',1,true,'谢谢你给我施肥！继续培养我，我就会给你提供更多有关游戏的建议！',8,20)
ON CONFLICT(id) DO NOTHING;
INSERT INTO model_replies(id,model_id,position,text)
SELECT gen_random_uuid(),id,1,reply_text FROM models WHERE id='wisdom-tree'
ON CONFLICT(model_id,position) DO NOTHING;
