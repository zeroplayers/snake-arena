-- Hand-written (Drizzle doesn't model triggers).
--
-- Whether a version may play also depends on its bot (`banned_at`, `archived_at`) and the bot's
-- owner (`banned_at`), so changing those bumps `versions.change_seq` of the `ready` versions they
-- cover, and the matchmaker's incremental poll sees a ban or unban even when no version's status
-- changes with it. Only `ready` versions can play, and a bot has at most one.
--
-- Each bumped version gets its own value above every existing one: the poll pages by
-- `change_seq > cursor`, so two versions sharing a value could be split across pages and skipped.
CREATE TRIGGER `bots_change_seq_playable` AFTER UPDATE OF `banned_at`, `archived_at` ON `bots`
WHEN NEW.`banned_at` IS NOT OLD.`banned_at` OR NEW.`archived_at` IS NOT OLD.`archived_at` BEGIN
	UPDATE `versions` SET `change_seq` = (SELECT max(`change_seq`) FROM `versions`) + 1
	WHERE `bot_id` = NEW.`id` AND `status` = 'ready';
END;--> statement-breakpoint
CREATE TRIGGER `users_change_seq_banned` AFTER UPDATE OF `banned_at` ON `users`
WHEN NEW.`banned_at` IS NOT OLD.`banned_at` BEGIN
	UPDATE `versions` SET `change_seq` = (SELECT max(`change_seq`) FROM `versions`) + (
		SELECT count(*) FROM `versions` AS `v` JOIN `bots` AS `b` ON `b`.`id` = `v`.`bot_id`
		WHERE `b`.`owner_id` = NEW.`id` AND `v`.`status` = 'ready' AND `v`.`bot_id` <= `versions`.`bot_id`
	)
	WHERE `status` = 'ready' AND `bot_id` IN (SELECT `id` FROM `bots` WHERE `owner_id` = NEW.`id`);
END;
