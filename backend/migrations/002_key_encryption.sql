-- Old digest-only keys remain usable, but their full value cannot be recovered.
ALTER TABLE api_keys ADD COLUMN key_ciphertext text;
