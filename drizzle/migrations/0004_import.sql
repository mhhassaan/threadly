CREATE TABLE legacy_imports (
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  migration_id TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, migration_id),
  UNIQUE (owner_id, legacy_id),
  FOREIGN KEY (thread_id, owner_id) REFERENCES owned_threads(id, owner_id) ON DELETE CASCADE
);
