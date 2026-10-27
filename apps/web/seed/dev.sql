-- Local development data: `pnpm db:seed` (after `pnpm db:migrate`). Never run against staging.
-- Re-runnable: every row has a `seed-` id and is replaced on each run.
--
-- Three authors (they have no GitHub account, so nobody can sign in as them), five bots and
-- ~600 lives, covering every version status, a ranked and an unranked version, and archived
-- history on the bot page.

DELETE FROM users WHERE id LIKE 'seed-%';

INSERT INTO users (id, name, email, email_verified, image, username, display_username, github_login) VALUES
  ('seed-ada', 'Ada', 'ada@seed.zerosnake.invalid', 1, NULL, 'ada', 'ada', 'ada'),
  ('seed-linus', 'Linus', 'linus@seed.zerosnake.invalid', 1, NULL, 'linus', 'linus', 'linus'),
  ('seed-grace', 'Grace', 'grace@seed.zerosnake.invalid', 1, NULL, 'grace', 'grace', 'grace');

INSERT INTO bots (id, owner_id, name, slug, skin, created_at) VALUES
  ('seed-greedy', 'seed-ada', 'Greedy', 'greedy', NULL, 1767225600000),
  ('seed-coward', 'seed-ada', 'Coward', 'coward', 'neon', 1767312000000),
  ('seed-spiral', 'seed-linus', 'Spiral', 'spiral', NULL, 1767398400000),
  ('seed-hunter', 'seed-grace', 'Hunter', 'hunter', 'tiger', 1767484800000),
  ('seed-wip', 'seed-grace', 'Work in progress', 'wip', NULL, 1767571200000);

INSERT INTO versions (id, bot_id, n, status, bundle_key, source_key, report, created_at, updated_at) VALUES
  ('seed-greedy-1', 'seed-greedy', 1, 'archived', 'seed/greedy/1.js', 'seed/greedy/1.tar.gz',
    '{"ok":true,"checks":[{"name":"loads","ok":true},{"name":"seeds","ok":true},{"name":"qualification","ok":true}],"qualificationScore":41}',
    1767225600000, 1767312000000),
  ('seed-greedy-2', 'seed-greedy', 2, 'ready', 'seed/greedy/2.js', 'seed/greedy/2.tar.gz',
    '{"ok":true,"checks":[{"name":"loads","ok":true},{"name":"seeds","ok":true},{"name":"qualification","ok":true}],"qualificationScore":63}',
    1767312000000, 1767312000000),
  ('seed-coward-1', 'seed-coward', 1, 'ready', 'seed/coward/1.js', 'seed/coward/1.tar.gz',
    '{"ok":true,"checks":[{"name":"loads","ok":true},{"name":"seeds","ok":true},{"name":"qualification","ok":true}],"qualificationScore":35}',
    1767312000000, 1767312000000),
  ('seed-spiral-1', 'seed-spiral', 1, 'rejected', 'seed/spiral/1.js', 'seed/spiral/1.tar.gz',
    '{"ok":false,"checks":[{"name":"loads","ok":true},{"name":"seeds","ok":false,"message":"seed 3: exceeded the op budget 3 ticks in a row at tick 412"}]}',
    1767398400000, 1767398400000),
  ('seed-spiral-2', 'seed-spiral', 2, 'ready', 'seed/spiral/2.js', 'seed/spiral/2.tar.gz',
    '{"ok":true,"checks":[{"name":"loads","ok":true},{"name":"seeds","ok":true},{"name":"qualification","ok":true}],"qualificationScore":52}',
    1767484800000, 1767484800000),
  ('seed-hunter-1', 'seed-hunter', 1, 'ready', 'seed/hunter/1.js', 'seed/hunter/1.tar.gz',
    '{"ok":true,"checks":[{"name":"loads","ok":true},{"name":"seeds","ok":true},{"name":"qualification","ok":true}],"qualificationScore":70}',
    1767484800000, 1767484800000),
  ('seed-wip-1', 'seed-wip', 1, 'validating', 'seed/wip/1.js', 'seed/wip/1.tar.gz', NULL,
    1767571200000, 1767571200000);

-- Lives: a fixed pseudo-random spread around each version's base score. Hunter has only 12 lives,
-- so it stays below the 30-life leaderboard threshold.
INSERT INTO lives (id, version_id, room, start_tick, end_tick, score, length_max, kills,
                   death_cause, killer, replay_key, trace_key, started_at, ended_at)
WITH RECURSIVE
  plan(version_id, n_lives, base, spread, t0) AS (VALUES
    ('seed-greedy-1', 120, 40, 30, 1767225600000),
    ('seed-greedy-2', 200, 60, 40, 1767312000000),
    ('seed-coward-1', 150, 30, 15, 1767312000000),
    ('seed-spiral-2', 110, 50, 35, 1767484800000),
    ('seed-hunter-1', 12, 75, 30, 1767484800000)
  ),
  seq(version_id, i, base, spread, t0, n_lives) AS (
    SELECT version_id, 0, base, spread, t0, n_lives FROM plan
    UNION ALL
    SELECT version_id, i + 1, base, spread, t0, n_lives FROM seq WHERE i + 1 < n_lives
  )
SELECT
  version_id || '-life-' || i,
  version_id,
  'seed-room-' || (i % 4),
  i * 900,
  i * 900 + 300 + (i * 37) % 600,
  base + (i * 7919) % spread,
  20 + (base + (i * 7919) % spread) / 2,
  (i * 13) % 4,
  CASE (i * 31) % 10
    WHEN 0 THEN 'wall' WHEN 1 THEN 'timeout' WHEN 2 THEN 'retired' ELSE 'collision' END,
  CASE WHEN (i * 31) % 10 >= 3 THEN
    CASE i % 3 WHEN 0 THEN 'house:medium' WHEN 1 THEN 'house:hard' ELSE 'seed-coward-1' END
  END,
  'seed/replays/' || version_id || '/' || i || '.bin',
  'seed/traces/' || version_id || '/' || i || '.json',
  t0 + i * 600000,
  t0 + i * 600000 + 300000
FROM seq;

-- Ratings over the last 200 lives, roughly: mean and 95% CI half-width. `life_seq` stays NULL,
-- so the rating job (`src/server/ratings.ts`) rebuilds them exactly on its first run.
-- `activated_at` names the version's current stint; a rating for any other one is ignored.
INSERT INTO ratings (version_id, activated_at, mean, ci, n_lives, updated_at)
SELECT
  version_id,
  (SELECT activated_at FROM versions WHERE id = version_id),
  avg(score),
  1.96 * sqrt((avg(score * score) - avg(score) * avg(score)) / count(*)),
  count(*),
  max(ended_at)
FROM (
  SELECT version_id, score, ended_at,
         row_number() OVER (PARTITION BY version_id ORDER BY ended_at DESC) AS recent
  FROM lives WHERE version_id LIKE 'seed-%'
)
WHERE recent <= 200
GROUP BY version_id;
