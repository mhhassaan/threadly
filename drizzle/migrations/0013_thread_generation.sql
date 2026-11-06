CREATE TABLE generation_guests (id TEXT PRIMARY KEY, token_digest TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE generation_claims (id TEXT NOT NULL UNIQUE, guest_id TEXT PRIMARY KEY REFERENCES generation_guests(id), account_key TEXT NOT NULL UNIQUE, owner_id TEXT REFERENCES user(id) ON DELETE SET NULL, utc_day TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE generation_jobs (
 id TEXT PRIMARY KEY, principal_key TEXT NOT NULL, guest_id TEXT REFERENCES generation_guests(id), owner_id TEXT REFERENCES user(id) ON DELETE SET NULL,
 request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, session_id TEXT, credential_generation INTEGER, settings_epoch INTEGER,
 status TEXT NOT NULL CHECK(status IN ('reserved','running','complete','failed','cancelled','stale')), phase TEXT,
 input_json TEXT, result_json TEXT, record_id TEXT NOT NULL UNIQUE, error_code TEXT,
 lease_until TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, refined INTEGER NOT NULL DEFAULT 0,
 UNIQUE(principal_key,request_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX generation_one_active ON generation_jobs(principal_key) WHERE status IN ('reserved','running');
--> statement-breakpoint
CREATE INDEX generation_expiry ON generation_jobs(expires_at);
--> statement-breakpoint
CREATE TABLE generation_debits (job_id TEXT PRIMARY KEY REFERENCES generation_jobs(id), principal_key TEXT NOT NULL, owner_id TEXT REFERENCES user(id) ON DELETE SET NULL, utc_day TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','used','released')));
--> statement-breakpoint
CREATE INDEX generation_quota ON generation_debits(principal_key,utc_day,state);
--> statement-breakpoint
CREATE TRIGGER generation_account_delete BEFORE DELETE ON user
BEGIN
 UPDATE generation_jobs SET input_json=NULL, result_json=NULL, status=CASE WHEN status IN ('reserved','running') THEN 'cancelled' ELSE status END, phase=NULL, error_code=CASE WHEN status IN ('reserved','running') THEN 'ACCOUNT_DELETED' ELSE error_code END WHERE owner_id=OLD.id;
 UPDATE generation_debits SET state='released' WHERE owner_id=OLD.id AND state='reserved';
END;
