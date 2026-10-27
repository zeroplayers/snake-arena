ALTER TABLE `ratings` ADD `lower_bound` real GENERATED ALWAYS AS (mean - ci) VIRTUAL;--> statement-breakpoint
CREATE INDEX `ratings_rank_idx` ON `ratings` (`lower_bound`,"ci" DESC,`n_lives`,"version_id" DESC);--> statement-breakpoint
ALTER TABLE `versions` ADD `lives_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Hand-written below (Drizzle doesn't model triggers): `versions.lives_count` counts the version's
-- `lives` rows, so the bot page, profile and leaderboard never aggregate `lives`. Writers of
-- `lives` (apps/arena) need do nothing. Avoid `INSERT OR REPLACE` on `lives`: its implicit delete
-- doesn't fire the delete trigger unless `recursive_triggers` is on.
UPDATE `versions` SET `lives_count` = (SELECT count(*) FROM `lives` WHERE `lives`.`version_id` = `versions`.`id`);--> statement-breakpoint
CREATE TRIGGER `lives_count_insert` AFTER INSERT ON `lives` BEGIN
	UPDATE `versions` SET `lives_count` = `lives_count` + 1 WHERE `id` = NEW.`version_id`;
END;--> statement-breakpoint
CREATE TRIGGER `lives_count_delete` AFTER DELETE ON `lives` BEGIN
	UPDATE `versions` SET `lives_count` = `lives_count` - 1 WHERE `id` = OLD.`version_id`;
END;--> statement-breakpoint
CREATE TRIGGER `lives_count_move` AFTER UPDATE OF `version_id` ON `lives` WHEN NEW.`version_id` IS NOT OLD.`version_id` BEGIN
	UPDATE `versions` SET `lives_count` = `lives_count` - 1 WHERE `id` = OLD.`version_id`;
	UPDATE `versions` SET `lives_count` = `lives_count` + 1 WHERE `id` = NEW.`version_id`;
END;
