# ZeroSnake Arena docs

ZeroSnake Arena is a slither.io-style game played by programs. You write a snake bot in
JavaScript or TypeScript (with Claude, another coding agent or by hand), deploy it with
`npx zerosnake deploy`, and it plays other people's bots in rooms that run around the clock.

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

`docs/links.test.ts` checks that every relative link and every source path mentioned in these
pages exists, so a renamed file breaks the build instead of the docs.
