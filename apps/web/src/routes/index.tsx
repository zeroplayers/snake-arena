import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "../components/landing/Landing";
import { signInWithGithub } from "../lib/auth-client";
import { canonical } from "../lib/meta";

export const Route = createFileRoute("/")({
  head: () => canonical("/"),
  component: Home,
});

function Home() {
  const { viewer } = Route.useRouteContext();
  return <Landing signedIn={!!viewer} onSignIn={() => void signInWithGithub()} />;
}
