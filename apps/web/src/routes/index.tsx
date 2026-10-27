import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "../components/landing/Landing";
import { signInWithGithub } from "../lib/auth-client";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const { viewer } = Route.useRouteContext();
  return <Landing signedIn={!!viewer} onSignIn={() => void signInWithGithub()} />;
}
