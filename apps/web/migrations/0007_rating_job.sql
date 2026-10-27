CREATE TABLE `rating_progress` (
	`id` integer PRIMARY KEY NOT NULL,
	`assigned_seq` integer DEFAULT 0 NOT NULL,
	`rated_seq` integer DEFAULT 0 NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "rating_progress_singleton" CHECK("rating_progress"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE `lives` ADD `seq` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `lives_seq_idx` ON `lives` (`seq`);--> statement-breakpoint
CREATE INDEX `lives_version_seq_idx` ON `lives` (`version_id`,`seq`);--> statement-breakpoint
ALTER TABLE `ratings` ADD `recent_scores` text;--> statement-breakpoint
ALTER TABLE `ratings` ADD `life_seq` integer;--> statement-breakpoint
CREATE INDEX `ratings_rebuild_idx` ON `ratings` (`version_id`) WHERE life_seq IS NULL;--> statement-breakpoint
-- Hand-written below (Drizzle doesn't model triggers or seed rows).
--
-- `lives.seq` numbers lives in the order they finished, for the rating job's cursor
-- (`src/server/ratings.ts`). The counter lives in `rating_progress`, not `max(seq) + 1`, so a
-- deleted newest life never hands its number out again (`rowid` would, and VACUUM may renumber
-- rowids). D1 runs one write transaction at a time, so a committed `seq` has every smaller one
-- committed before it: a cursor `WHERE seq > ?` never skips a life, however late the arena
-- writes it. Lives already in the table are numbered by when they ended.
INSERT INTO `rating_progress` (`id`) VALUES (1);--> statement-breakpoint
UPDATE `lives` SET `seq` = `numbered`.`n`
FROM (
	SELECT `rowid` AS `rid`, row_number() OVER (ORDER BY `ended_at`, `rowid`) AS `n`
	FROM `lives` WHERE `end_tick` IS NOT NULL
) AS `numbered`
WHERE `lives`.`rowid` = `numbered`.`rid`;--> statement-breakpoint
UPDATE `rating_progress` SET `assigned_seq` = (SELECT coalesce(max(`seq`), 0) FROM `lives`) WHERE `id` = 1;--> statement-breakpoint
CREATE TRIGGER `lives_seq_insert` AFTER INSERT ON `lives` WHEN NEW.`end_tick` IS NOT NULL BEGIN
	UPDATE `rating_progress` SET `assigned_seq` = `assigned_seq` + 1 WHERE `id` = 1;
	UPDATE `lives` SET `seq` = (SELECT `assigned_seq` FROM `rating_progress` WHERE `id` = 1) WHERE `rowid` = NEW.`rowid`;
END;--> statement-breakpoint
-- A life written while alive is numbered when it ends.
CREATE TRIGGER `lives_seq_finish` AFTER UPDATE OF `end_tick` ON `lives` WHEN NEW.`end_tick` IS NOT NULL AND NEW.`seq` IS NULL BEGIN
	UPDATE `rating_progress` SET `assigned_seq` = `assigned_seq` + 1 WHERE `id` = 1;
	UPDATE `lives` SET `seq` = (SELECT `assigned_seq` FROM `rating_progress` WHERE `id` = 1) WHERE `rowid` = NEW.`rowid`;
END;
