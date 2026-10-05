-- Account deletion permanently removes every user-owned record. Administrative
-- history and global update jobs retain anonymous references instead of profiles.
ALTER TABLE trees DROP CONSTRAINT trees_user_id_fkey;
ALTER TABLE trees ADD CONSTRAINT trees_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey;
ALTER TABLE sessions ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE identities DROP CONSTRAINT identities_user_id_fkey;
ALTER TABLE identities ADD CONSTRAINT identities_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE oauth_states DROP CONSTRAINT oauth_states_bind_user_id_fkey;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_bind_user_id_fkey FOREIGN KEY(bind_user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE daily_claims DROP CONSTRAINT daily_claims_user_id_fkey;
ALTER TABLE daily_claims ADD CONSTRAINT daily_claims_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ledger DROP CONSTRAINT ledger_user_id_fkey;
ALTER TABLE ledger ADD CONSTRAINT ledger_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE game_actions DROP CONSTRAINT game_actions_user_id_fkey;
ALTER TABLE game_actions ADD CONSTRAINT game_actions_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE api_requests DROP CONSTRAINT api_requests_user_id_fkey;
ALTER TABLE api_requests ADD CONSTRAINT api_requests_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE api_requests DROP CONSTRAINT api_requests_api_key_id_fkey;
ALTER TABLE api_requests ADD CONSTRAINT api_requests_api_key_id_fkey FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_user_id_fkey;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE model_reply_cursors DROP CONSTRAINT model_reply_cursors_user_id_fkey;
ALTER TABLE model_reply_cursors ADD CONSTRAINT model_reply_cursors_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE audit ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE audit DROP CONSTRAINT audit_actor_id_fkey;
ALTER TABLE audit ADD CONSTRAINT audit_actor_id_fkey FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE system_update_jobs ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE system_update_jobs DROP CONSTRAINT system_update_jobs_actor_id_fkey;
ALTER TABLE system_update_jobs ADD CONSTRAINT system_update_jobs_actor_id_fkey FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX audit_target_id_casefold_idx ON audit(lower(target_id));
CREATE INDEX audit_actor_id_idx ON audit(actor_id);
CREATE INDEX api_requests_api_key_idx ON api_requests(api_key_id);
CREATE INDEX oauth_states_bind_user_idx ON oauth_states(bind_user_id);
CREATE INDEX oauth_states_session_idx ON oauth_states(session_hash);

UPDATE audit SET target_id='deleted-user',reason='已删除用户的操作记录',before_value=NULL,after_value=NULL
WHERE lower(target_id) IN (SELECT id::text FROM users WHERE status='deleted');
UPDATE audit SET actor_id=NULL,actor_name='已删除管理员'
WHERE actor_id IN (SELECT id FROM users WHERE status='deleted');
DELETE FROM oauth_states WHERE session_hash IN (
  SELECT token_hash FROM sessions WHERE user_id IN (SELECT id FROM users WHERE status='deleted')
);
DELETE FROM users WHERE status='deleted';
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK(status IN ('active','banned'));
