CREATE TABLE `arena_heartbeat` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`lives_in_flight` integer NOT NULL,
	`rooms` integer NOT NULL,
	CONSTRAINT "arena_heartbeat_singleton" CHECK("arena_heartbeat"."id" = 1)
);
--> statement-breakpoint
-- Hand-written from here (Drizzle's table rebuild copies the generated column and drops the
-- triggers). Long lives (`@zerosnake/rating`, `src/server/ratings.ts`): ratings become points per
-- minute alive, ranked from an hour alive (`alive_ticks`); `ci` may be NULL (too little evidence
-- for an interval, e.g. an hour-long life and a death at spawn). SQLite can't drop NOT NULL in
-- place, so `ratings` is rebuilt; its rows are copied as they are, so the site keeps serving them
-- until its new code is deployed. Nothing references `ratings`.
CREATE TABLE `__new_ratings` (
	`version_id` text PRIMARY KEY NOT NULL,
	`mean` real NOT NULL,
	`ci` real,
	`n_lives` integer NOT NULL,
	`alive_ticks` integer DEFAULT 0 NOT NULL,
	`activated_at` integer,
	`lower_bound` real GENERATED ALWAYS AS (mean - ci) VIRTUAL,
	`recent_scores` text,
	`life_seq` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_ratings` (`version_id`, `mean`, `ci`, `n_lives`, `activated_at`, `recent_scores`, `life_seq`, `updated_at`)
SELECT `version_id`, `mean`, `ci`, `n_lives`, `activated_at`, `recent_scores`, `life_seq`, `updated_at` FROM `ratings`;--> statement-breakpoint
DROP TABLE `ratings`;--> statement-breakpoint
ALTER TABLE `__new_ratings` RENAME TO `ratings`;--> statement-breakpoint
CREATE INDEX `ratings_mean_idx` ON `ratings` (`mean`);--> statement-breakpoint
CREATE INDEX `ratings_rank_idx` ON `ratings` (`lower_bound`,"ci" DESC,`alive_ticks`,"version_id" DESC);--> statement-breakpoint
CREATE INDEX `ratings_rebuild_idx` ON `ratings` (`version_id`) WHERE life_seq IS NULL OR json_extract(recent_scores, '$.v') = 1;--> statement-breakpoint
-- The stint triggers of migration 0004, which the rebuild dropped.
CREATE TRIGGER `ratings_stint_insert` BEFORE INSERT ON `ratings`
WHEN NEW.`activated_at` IS NOT (SELECT `activated_at` FROM `versions` WHERE `id` = NEW.`version_id`) BEGIN
	SELECT RAISE(IGNORE);
END;--> statement-breakpoint
CREATE TRIGGER `ratings_stint_update` BEFORE UPDATE ON `ratings`
WHEN NEW.`activated_at` IS NOT (SELECT `activated_at` FROM `versions` WHERE `id` = NEW.`version_id`) BEGIN
	SELECT RAISE(IGNORE);
END;--> statement-breakpoint
ALTER TABLE `rating_progress` ADD `format` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `rating_progress` ADD `job_rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The reset itself is the new rating job's (`src/server/ratings.ts`, "Format"): on its first run
-- it sees `format = 1`, deletes every rating, moves the cursor back to 0 and sets `format = 2`, so
-- every rating is rebuilt from `lives` (each holds `start_tick` and `end_tick`), whatever the old
-- job did between this migration and the site's deploy. From then on these triggers keep the old
-- code out. A cursor move that changes `rev` without setting `job_rev` to it (only the new job
-- does) aborts: a job commit is one D1 batch, a transaction, with the cursor move last, so a run
-- of the old code still in flight loses its whole commit, upserts and deletes included (a delete
-- trigger couldn't tell its deletes from the site's rollbacks or a deleted account's cascade).
-- A rating with a version-1 window (scores without lengths) is ignored too.
CREATE TRIGGER `rating_progress_current_job` BEFORE UPDATE ON `rating_progress`
WHEN OLD.`format` >= 2 AND NEW.`rev` IS NOT OLD.`rev` AND NEW.`job_rev` IS NOT NEW.`rev` BEGIN
	SELECT RAISE(ABORT, 'old rating job: its commit is refused since the ratings format changed');
END;--> statement-breakpoint
CREATE TRIGGER `ratings_no_v1_insert` BEFORE INSERT ON `ratings`
WHEN json_extract(NEW.`recent_scores`, '$.v') = 1 AND (SELECT `format` FROM `rating_progress` WHERE `id` = 1) >= 2 BEGIN
	SELECT RAISE(IGNORE);
END;--> statement-breakpoint
CREATE TRIGGER `ratings_no_v1_update` BEFORE UPDATE ON `ratings`
WHEN json_extract(NEW.`recent_scores`, '$.v') = 1 AND (SELECT `format` FROM `rating_progress` WHERE `id` = 1) >= 2 BEGIN
	SELECT RAISE(IGNORE);
END;
