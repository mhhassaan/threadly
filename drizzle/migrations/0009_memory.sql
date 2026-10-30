ALTER TABLE comments ADD COLUMN used_memory_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE account_settings ADD COLUMN memory_reset_at TEXT;
-- One row per regular supports future per-participant resets without erasing history.
CREATE TABLE memory_resets (
 owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 persona_id TEXT NOT NULL,
 reset_at TEXT NOT NULL,
 PRIMARY KEY(owner_id, persona_id)
);
CREATE TABLE participant_memories (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 persona_id TEXT NOT NULL,
 text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 600),
 evidence_ids TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 turn_id TEXT NOT NULL,
 UNIQUE(owner_id, persona_id, epoch, text, evidence_ids)
);
CREATE INDEX memory_owner_persona ON participant_memories(owner_id, persona_id, epoch);
CREATE TABLE memory_evidence (
 memory_id TEXT NOT NULL REFERENCES participant_memories(id) ON DELETE CASCADE,
 comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
 thread_revision INTEGER NOT NULL,
 source_revision INTEGER NOT NULL,
 PRIMARY KEY(memory_id, comment_id)
);
