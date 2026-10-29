-- Persistent password-generation fencing across independent Workers.
ALTER TABLE "user" ADD COLUMN "credential_generation" INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "credential_generation" INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TRIGGER auth_password_generation
AFTER UPDATE OF password ON account
WHEN NEW.provider_id = 'credential' AND OLD.password IS NOT NEW.password
BEGIN
  UPDATE "user" SET credential_generation = credential_generation + 1 WHERE id = NEW.user_id;
  DELETE FROM session WHERE user_id = NEW.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER auth_session_generation
BEFORE INSERT ON session
WHEN NEW.credential_generation IS NOT (SELECT credential_generation FROM "user" WHERE id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'Stale credential generation');
END;
