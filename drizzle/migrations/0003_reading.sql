CREATE TABLE owned_threads (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision > 0),
  record_json TEXT NOT NULL,
  source_text TEXT,
  mutation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, owner_id)
);
CREATE INDEX owned_threads_owner ON owned_threads(owner_id, id);
CREATE TABLE owned_posts (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  text TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (thread_id, owner_id) REFERENCES owned_threads(id, owner_id) ON DELETE CASCADE,
  UNIQUE (id, thread_id, owner_id),
  UNIQUE (thread_id, position)
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  parent_id TEXT,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'ai')),
  author_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  created_at TEXT NOT NULL,
  turn_id TEXT,
  passage_ids TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (post_id, thread_id, owner_id) REFERENCES owned_posts(id, thread_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id, thread_id, post_id, owner_id) REFERENCES comments(id, thread_id, post_id, owner_id),
  UNIQUE (id, thread_id, post_id, owner_id),
  UNIQUE (thread_id, sequence)
);
CREATE INDEX comments_post ON comments(owner_id, thread_id, post_id, sequence);
CREATE TABLE reading_progress (
  thread_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  FOREIGN KEY (post_id, thread_id, owner_id) REFERENCES owned_posts(id, thread_id, owner_id) ON DELETE CASCADE
);
