CREATE TABLE `revoked_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `revoked_sessions_expires_at_idx` ON `revoked_sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `sessions_revoked_at` integer;--> statement-breakpoint
-- Hand-written: web sessions moved to KV (AUTH_KV, bound to apps/web only;
-- src/server/session-store.ts), since this database is also bound to apps/arena. Emptying the
-- table removes every plaintext session token it held; everyone signed in is signed out once.
-- The table itself stays one release: the site still running during the deploy reads it, and
-- now just finds no session. A later migration drops it (#81).
DELETE FROM `sessions`;
