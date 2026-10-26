# ZeroSnake Arena docs

ZeroSnake Arena is a slither.io-style game played by programs. You write a snake bot in
JavaScript or TypeScript (usually together with Claude), deploy it with `npx zerosnake deploy`, and
it plays other people's bots around the clock in persistent rooms.

| Page                                  | What it covers                                                         |
| ------------------------------------- | ---------------------------------------------------------------------- |
| [Getting started](getting-started.md) | From `npx zerosnake init` to a bot in the arena                        |
| [Rules](rules.md)                     | Movement, turning, boost, food, growth, hunger, collisions, scoring    |
| [Bot API](bot-api.md)                 | `init`, `tick`, `state`, `info`, actions, memory, `log()`, coordinates |
| [Limits](limits.md)                   | Sandbox budget and memory, forbidden features, deploy limits, checks   |
| [Rating](rating.md)                   | How versions are rated and ranked                                      |
| [FAQ](faq.md)                         | Common questions and causes of death                                   |

## How these pages are kept accurate

Every number here comes from the code, and each page links to the files it was taken from. When
the code and a page disagree, the code wins: please open an issue or a PR.

Parts of the platform are still being built. Those places say so and link to the pull request or
issue, rather than describing behaviour that isn't merged yet. The status as of this writing:

| Piece                                              | Status                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Engine, SDK, sandbox, house bots, renderer, viewer | merged                                                                                                                                 |
| CLI `init`, `sim`, `test`                          | in review ([#57](https://github.com/zeroplayers/snake-arena/pull/57))                                                                  |
| Bot template (`CLAUDE.md`, skills, tests)          | in review ([#53](https://github.com/zeroplayers/snake-arena/pull/53))                                                                  |
| Check suite                                        | in review ([#54](https://github.com/zeroplayers/snake-arena/pull/54))                                                                  |
| Deploy API and its limits                          | in review ([#52](https://github.com/zeroplayers/snake-arena/pull/52))                                                                  |
| Rating and leaderboard order                       | in review ([#51](https://github.com/zeroplayers/snake-arena/pull/51), [#55](https://github.com/zeroplayers/snake-arena/pull/55))       |
| Rooms (`RoomDO`)                                   | in review ([#56](https://github.com/zeroplayers/snake-arena/pull/56))                                                                  |
| CLI `login`, `deploy`, `status`, `logs`            | not started ([#21](https://github.com/zeroplayers/snake-arena/issues/21))                                                              |
| Matchmaker, check queue consumer                   | not started ([#23](https://github.com/zeroplayers/snake-arena/issues/23), [#22](https://github.com/zeroplayers/snake-arena/issues/22)) |
| CPU-accurate op metering in the sandbox            | in progress ([#60](https://github.com/zeroplayers/snake-arena/issues/60))                                                              |

`docs/links.test.ts` checks that every relative link and every source path mentioned in these
pages exists, so a renamed file breaks the build instead of the docs.
