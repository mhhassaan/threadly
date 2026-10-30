-- Durable individual evidence suppression prevents recreation from old history.
CREATE TABLE memory_suppressions (
 owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 persona_id TEXT NOT NULL,
 comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
 PRIMARY KEY(owner_id,persona_id,comment_id)
);
--> statement-breakpoint
ALTER TABLE owned_threads ADD COLUMN opening_blocked INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TRIGGER privacy_memory_delete BEFORE DELETE ON participant_memories
BEGIN
 UPDATE comments SET used_memory_ids = COALESCE((SELECT json_group_array(value) FROM json_each(used_memory_ids) WHERE value <> OLD.id),'[]') WHERE owner_id = OLD.owner_id AND EXISTS (SELECT 1 FROM json_each(used_memory_ids) WHERE value = OLD.id);
END;
--> statement-breakpoint
CREATE TRIGGER privacy_comment_delete BEFORE DELETE ON comments
BEGIN
 DELETE FROM participant_memories WHERE owner_id = OLD.owner_id AND id IN (SELECT memory_id FROM memory_evidence WHERE comment_id = OLD.id);
END;
--> statement-breakpoint
CREATE TRIGGER privacy_account_delete BEFORE DELETE ON user
BEGIN
 DELETE FROM verification WHERE value = OLD.id OR identifier = OLD.email;
 DELETE FROM rate_limit WHERE substr(key,1,length('account-delete:' || OLD.id || ':')) = 'account-delete:' || OLD.id || ':';
END;

--> statement-breakpoint
CREATE TRIGGER privacy_reset_owner BEFORE INSERT ON verification
WHEN NEW.identifier LIKE 'reset-password:%' AND NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.value)
BEGIN
 SELECT RAISE(ABORT,'Account unavailable');
END;
