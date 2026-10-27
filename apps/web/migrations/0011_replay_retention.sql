-- Replay retention (#78): `replay_expired_at` marks lives whose replay chunk the sweep deleted
-- (`src/server/replays.ts`). The partial indexes hold only lives whose replay is still there.
ALTER TABLE `lives` ADD `replay_expired_at` integer;--> statement-breakpoint
CREATE INDEX `lives_replay_score_idx` ON `lives` (`score`) WHERE replay_key IS NOT NULL AND replay_expired_at IS NULL;--> statement-breakpoint
CREATE INDEX `lives_version_replay_score_idx` ON `lives` (`version_id`,`score`) WHERE replay_key IS NOT NULL AND replay_expired_at IS NULL;--> statement-breakpoint
CREATE INDEX `lives_replay_key_idx` ON `lives` (`replay_key`) WHERE replay_expired_at IS NULL;