CREATE TABLE site_assets (
  filename text PRIMARY KEY CHECK(filename ~ '^[a-f0-9]{32}\.(png|webp)$'),
  slot text NOT NULL CHECK(slot IN ('logo','favicon','garden-background')),
  mime_type text NOT NULL CHECK(mime_type IN ('image/png','image/webp')),
  byte_size integer NOT NULL CHECK(byte_size > 0 AND byte_size <= 2097152),
  width integer NOT NULL CHECK(width > 0 AND width <= 2560),
  height integer NOT NULL CHECK(height > 0 AND height <= 2560),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE site_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  site_name text NOT NULL DEFAULT '智慧树' CHECK(char_length(site_name) BETWEEN 1 AND 60),
  browser_title text NOT NULL DEFAULT '智慧树 · 养成与 API' CHECK(char_length(browser_title) BETWEEN 1 AND 120),
  garden_subtitle text NOT NULL DEFAULT '每天照料一点，让智慧慢慢生长。' CHECK(char_length(garden_subtitle) <= 200),
  footer_text text NOT NULL DEFAULT '一棵树，一个慢慢生长的花园。' CHECK(char_length(footer_text) <= 300),
  logo_filename text REFERENCES site_assets(filename),
  favicon_filename text REFERENCES site_assets(filename),
  garden_background_filename text REFERENCES site_assets(filename),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO site_settings(id) VALUES(true);
-- Past uploaded assets remain available so that an earlier database backup can
-- still reference its original pictures after restoring the paired media volume.
