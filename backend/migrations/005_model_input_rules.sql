-- Public model IDs are editable; dependent references follow a rename atomically.
ALTER TABLE api_requests DROP CONSTRAINT api_requests_model_id_fkey;
ALTER TABLE api_requests ADD CONSTRAINT api_requests_model_id_fkey
  FOREIGN KEY(model_id) REFERENCES models(id) ON UPDATE CASCADE;

-- The site's tree keeps its model identity even after its public ID changes.
ALTER TABLE models ADD COLUMN is_wisdom_tree boolean NOT NULL DEFAULT false;
UPDATE models SET is_wisdom_tree=true WHERE id='wisdom-tree';
CREATE UNIQUE INDEX models_one_wisdom_tree_idx ON models(is_wisdom_tree) WHERE is_wisdom_tree=true;

CREATE TABLE model_reply_rules (
  id uuid PRIMARY KEY,
  model_id text NOT NULL REFERENCES models(id) ON UPDATE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 1000000),
  input text NOT NULL CHECK (length(input) BETWEEN 1 AND 2000),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(model_id,position)
);
-- Inputs can contain 2000 multibyte characters, so keep long text out of the
-- btree. A model has at most 500 rules; filtering its ordered partial index is bounded.
CREATE INDEX model_reply_rules_match_idx ON model_reply_rules(model_id,position) WHERE enabled=true;

-- Correct only the legacy, untouched placeholder. User-edited text and all 80
-- imported entries remain intact; the fallback now agrees with the first entry.
UPDATE models m SET reply_text=(
  SELECT r.text FROM model_replies r WHERE r.model_id=m.id ORDER BY r.position,r.id LIMIT 1
),updated_at=now()
WHERE m.is_wisdom_tree=true
  AND m.reply_text='谢谢你给我施肥！继续培养我，我就会给你提供更多有关游戏的建议！'
  AND EXISTS(SELECT 1 FROM model_replies r WHERE r.model_id=m.id);
