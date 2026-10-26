// Secrets aren't in wrangler.jsonc, so `wrangler types` only sees them when `.dev.vars` exists.
declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
  }
}
