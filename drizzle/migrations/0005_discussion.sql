CREATE TABLE source_passages (
  id TEXT NOT NULL, thread_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset), text TEXT NOT NULL,
  FOREIGN KEY (thread_id, owner_id) REFERENCES owned_threads(id, owner_id) ON DELETE CASCADE,
  UNIQUE (thread_id, owner_id, source_revision, id)
);
CREATE TABLE guest_identities (
  id TEXT NOT NULL, thread_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  name TEXT NOT NULL, handle TEXT NOT NULL, voice TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  FOREIGN KEY (thread_id, owner_id) REFERENCES owned_threads(id, owner_id) ON DELETE CASCADE,
  UNIQUE (thread_id, owner_id, id)
);
