import type { BetterAuthClientPlugin } from "better-auth/client";
import { deviceAuthorizationClient, inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { Auth } from "../server/auth";
import type { cliAuth } from "../server/cli-auth";
import type { usernameClaim } from "../server/username";

const serverPlugins = () =>
  ({
    id: "zerosnake",
    $InferServerPlugin: {} as ReturnType<typeof cliAuth> | ReturnType<typeof usernameClaim>,
  }) satisfies BetterAuthClientPlugin;

/** Browser client for /api/auth (same origin). */
export const authClient = createAuthClient({
  plugins: [deviceAuthorizationClient(), inferAdditionalFields<Auth>(), serverPlugins()],
});

export function signInWithGithub(callbackURL = window.location.href) {
  return authClient.signIn.social({ provider: "github", callbackURL });
}
