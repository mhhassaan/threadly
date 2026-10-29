CREATE TABLE ai_opening_admissions (
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  turn_id TEXT,
  PRIMARY KEY(owner_id, request_id),
  FOREIGN KEY(canonical_id, owner_id) REFERENCES ai_requests(id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY(turn_id, owner_id) REFERENCES ai_turns(id, owner_id) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO ai_opening_admissions (owner_id, request_id, canonical_id, turn_id)
SELECT r.owner_id, r.request_id, r.id, (SELECT a.id FROM ai_turns a WHERE a.request_id = r.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1)
FROM ai_requests r WHERE r.kind = 'opening';
