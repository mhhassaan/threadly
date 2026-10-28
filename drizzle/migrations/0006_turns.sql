CREATE TABLE account_settings (owner_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, ai_enabled INTEGER NOT NULL DEFAULT 0, memory_enabled INTEGER NOT NULL DEFAULT 0, consent_at TEXT, memory_epoch INTEGER NOT NULL DEFAULT 0, settings_epoch INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE ai_requests (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, request_id TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('opening','reply')), trigger_comment_id TEXT, source_revision INTEGER NOT NULL, utc_day TEXT NOT NULL, UNIQUE(owner_id, request_id), UNIQUE(id, owner_id), FOREIGN KEY(thread_id, owner_id) REFERENCES owned_threads(id, owner_id) ON DELETE CASCADE);
--> statement-breakpoint
CREATE UNIQUE INDEX ai_one_opening ON ai_requests(thread_id, owner_id, source_revision) WHERE kind = 'opening';
--> statement-breakpoint
CREATE TABLE ai_turns (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('reserved','running','complete','failed','cancelled','stale')), lease_until TEXT NOT NULL, thread_revision INTEGER NOT NULL, source_revision INTEGER NOT NULL, settings_epoch INTEGER NOT NULL, memory_epoch INTEGER NOT NULL, created_at TEXT NOT NULL, error_code TEXT, FOREIGN KEY(request_id, owner_id) REFERENCES ai_requests(id, owner_id) ON DELETE CASCADE, FOREIGN KEY(thread_id, owner_id) REFERENCES owned_threads(id, owner_id) ON DELETE CASCADE, UNIQUE(id, owner_id));
--> statement-breakpoint
CREATE UNIQUE INDEX ai_one_active_thread ON ai_turns(thread_id, owner_id) WHERE status IN ('reserved','running');
--> statement-breakpoint
CREATE TABLE ai_allowances (request_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, utc_day TEXT NOT NULL, kind TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE ai_usage (turn_id TEXT PRIMARY KEY, owner_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, utc_day TEXT NOT NULL, reserved_micros INTEGER NOT NULL CHECK(reserved_micros > 0), input_tokens INTEGER, output_tokens INTEGER, estimated_cost_micros INTEGER);
