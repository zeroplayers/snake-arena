CREATE TABLE `arena_heartbeat` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`lives_in_flight` integer NOT NULL,
	`rooms` integer NOT NULL,
	CONSTRAINT "arena_heartbeat_singleton" CHECK("arena_heartbeat"."id" = 1)
);
--> statement-breakpoint
DROP INDEX `ratings_rank_idx`;--> statement-breakpoint
DROP INDEX `ratings_rebuild_idx`;--> statement-breakpoint
ALTER TABLE `ratings` ADD `alive_ticks` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `ratings_rank_idx` ON `ratings` (`lower_bound`,"ci" DESC,`alive_ticks`,"version_id" DESC);--> statement-breakpoint
CREATE INDEX `ratings_rebuild_idx` ON `ratings` (`version_id`) WHERE life_seq IS NULL OR alive_ticks = 0;--> statement-breakpoint
-- Hand-written below (Drizzle doesn't model data changes).
--
-- Ratings become points per minute alive (`@zerosnake/rating`, `src/server/ratings.ts`):
-- Σ score / Σ minutes over the last 200 counted lives, ranked from an hour alive
-- (`alive_ticks`). Every stored rating is a mean score per life over a window of scores without
-- lengths, so none can be continued: they are deleted and rebuilt from `lives`, which hold each
-- life's `start_tick` and `end_tick`. Moving the job's cursor back to 0 makes its next runs replay
-- every finished life (20 000 a minute) and write each version's rating anew; `ratings.life_seq`
-- keeps every life counted once, and bumping `rev` makes a run in flight commit nothing. The
-- rebuild also counts retired lives that reached the life cap (`end_tick - start_tick` equal to
-- a cap, 6000 before long lives), which the old job left out together with the lives the
-- platform stopped. The leaderboard fills up again within minutes.
--
-- The site still runs the old job until its deploy, a minute or so after this: rows it writes
-- meanwhile keep `alive_ticks` at 0, and the new job rebuilds those (`ratings_rebuild_idx`).
DELETE FROM `ratings`;--> statement-breakpoint
UPDATE `rating_progress` SET `rated_seq` = 0, `rev` = `rev` + 1 WHERE `id` = 1;