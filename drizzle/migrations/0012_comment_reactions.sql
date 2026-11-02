CREATE TABLE comment_reactions (
  comment_id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  liked INTEGER NOT NULL DEFAULT 0 CHECK (liked IN (0, 1)),
  reposted INTEGER NOT NULL DEFAULT 0 CHECK (reposted IN (0, 1)),
  bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (bookmarked IN (0, 1)),
  FOREIGN KEY (comment_id, thread_id, post_id, owner_id)
    REFERENCES comments(id, thread_id, post_id, owner_id) ON DELETE CASCADE
);
CREATE INDEX comment_reactions_owner_thread ON comment_reactions(owner_id, thread_id);

CREATE TABLE post_reactions (
  post_id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  liked INTEGER NOT NULL DEFAULT 0 CHECK (liked IN (0, 1)),
  reposted INTEGER NOT NULL DEFAULT 0 CHECK (reposted IN (0, 1)),
  bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (bookmarked IN (0, 1)),
  FOREIGN KEY (post_id, thread_id, owner_id)
    REFERENCES owned_posts(id, thread_id, owner_id) ON DELETE CASCADE
);
CREATE INDEX post_reactions_owner_thread ON post_reactions(owner_id, thread_id);
