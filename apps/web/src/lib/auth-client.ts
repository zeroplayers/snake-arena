import type { BetterAuthClientPlugin } from "better-auth/client";
import {
  deviceAuthorizationClient,
  inferAdditionalFields,
  usernameClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { Auth } from "../server/auth";
import type { cliTokens } from "../server/cli-tokens";

const cliTokensClient = () =>
  ({
    id: "cli-tokens",
    $InferServerPlugin: {} as ReturnType<typeof cliTokens>,
  }) satisfies BetterAuthClientPlugin;

/** Browser client for /api/auth (same origin). */
export const authClient = createAuthClient({
  plugins: [
    usernameClient(),
    deviceAuthorizationClient(),
    inferAdditionalFields<Auth>(),
    cliTokensClient(),
  ],
});

export function signInWithGithub(callbackURL = window.location.href) {
  return authClient.signIn.social({ provider: "github", callbackURL });
}
