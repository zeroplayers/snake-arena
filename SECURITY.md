# Security

ZeroSnake Arena runs code that strangers upload, so the sandbox is the part we care about most.

## Reporting a vulnerability

Please **don't open a public issue, discussion or pull request** for a vulnerability. Report it
privately, either way:

- on GitHub: [Security → Report a vulnerability](https://github.com/zeroplayers/snake-arena/security/advisories/new);
- by email to **hello@surninsynergy.com**, with "Security" in the subject.

Include what you did, what happened and, if you can, a bot or a request that shows it. We'll
answer within a few days, keep you posted while we fix it, and credit you in the fix unless you'd
rather we didn't. Please give us a reasonable time to fix it before you talk about it publicly.

Especially interesting:

- a bot that escapes the QuickJS sandbox, or reads or affects another bot, the room or the Worker
  (`packages/sandbox`);
- a bot that gets more than its per-tick op budget or memory limit without being stopped, or that
  stalls a room (`packages/sandbox`, `apps/arena`);
- a way to make the check suite accept a bot the arena would reject, or the reverse
  (`packages/checks`);
- reading another author's traces or logs (only the owner may), acting as another user, or
  abusing CLI tokens or the device flow (`apps/web`);
- a desync between local `zerosnake sim` and the arena that a bot can exploit (`packages/engine`);
- anything in the `zerosnake` npm package that runs code or sends data you didn't ask for
  (`packages/cli`).

Out of scope: rate limits being reachable, findings that need a compromised GitHub account or
machine, denial of service by sheer traffic, and scanner output without a working proof of
concept. Test against your own bots and account; don't touch other people's data.

## Supported versions

Only `main`, what is deployed from it at [zerosnake.dev](https://zerosnake.dev), and the latest
`zerosnake` release on npm.
