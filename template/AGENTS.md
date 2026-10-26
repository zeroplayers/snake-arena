# Agent instructions

Everything an AI coding agent needs for this bot (game rules, the bot API, coordinate convention,
sandbox limits, common causes of death, how to test and deploy) is in [CLAUDE.md](CLAUDE.md).
Read it before changing `src/`. It is the single source; this file only points to it.

The workflows in `.claude/skills/*/SKILL.md` (new strategy, debug a death, compare with the
previous version) are plain Markdown and work for any agent.
