# Security

ZeroSnake Arena runs code that strangers upload, so the sandbox is the part we care about most.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/zeroplayers/snake-arena/security/advisories/new).
We'll answer within a few days and credit you in the fix unless you'd rather we didn't.

Especially interesting:

- a bot that escapes the QuickJS sandbox, reads or affects another bot, the room or the Worker
  (`packages/sandbox`);
- a bot that gets more than its per-tick op budget or memory limit without being stopped, or
  that stalls a room (`packages/sandbox`, `apps/arena`);
- a way to make the check suite accept a bot the arena would reject, or the reverse
  (`packages/checks`);
- reading another author's traces or logs (only the owner may); acting as another user; abusing
  CLI tokens or the device flow (`apps/web`);
- a desync between local `zerosnake sim` and the arena that a bot can exploit (`packages/engine`).

Out of scope: rate limits being reachable, findings that need a compromised GitHub account, and
reports from automated scanners without a working proof of concept.

## Supported versions

Only `main` and what is deployed from it.
