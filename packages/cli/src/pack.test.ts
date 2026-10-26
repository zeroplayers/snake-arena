import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packageRoot } from "./paths.ts";
import { cleanUp, GOOD_BOT, makeProject, TUNING } from "./testing/project.ts";

afterAll(cleanUp);

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/**
 * The published package, as npm would install it, outside the monorepo: `pnpm pack` (which runs
 * `prepack`, the build), unpacked into a fresh `node_modules`. Its npm dependencies are linked
 * from this workspace instead of downloaded, so the test runs offline; nothing else from the
 * monorepo is reachable from there.
 */
describe("the packed CLI", () => {
  it("installs and runs init and sim with nothing but its own files", () => {
    const root = packageRoot();
    const tmp = makeProject({ "package.json": JSON.stringify({ name: "outside", private: true }) });

    const pack = run("pnpm", ["pack", "--pack-destination", tmp], root);
    expect(pack.code, pack.err).toBe(0);
    const tarball = readdirSync(tmp).find((f) => f.endsWith(".tgz")) as string;
    const listing = run("tar", ["-tzf", join(tmp, tarball)], tmp)
      .out.split("\n")
      .filter(Boolean);
    expect(listing.every((f) => /^package\/(bin|dist)\/|^package\/[^/]+$/.test(f))).toBe(true);
    expect(listing).toContain("package/dist/cli.js");
    expect(listing).toContain("package/dist/client.js");

    const installed = join(tmp, "node_modules", "zerosnake");
    mkdirSync(installed, { recursive: true });
    expect(
      run("tar", ["-xzf", join(tmp, tarball), "-C", installed, "--strip-components=1"], tmp).code,
    ).toBe(0);
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=24");
    for (const dep of Object.keys(pkg.dependencies)) {
      expect(dep.startsWith("@zerosnake/"), `${dep} isn't on npm`).toBe(false);
      const link = join(tmp, "node_modules", dep);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(realpathSync(join(root, "node_modules", dep)), link);
    }
    const bin = join(installed, "bin", "zerosnake.js");

    const version = run("node", [bin, "--version"], tmp);
    expect(version.err).toBe("");
    expect(version.out.trim()).toBe(pkg.version);

    const init = run("node", [bin, "init", "my-bot"], tmp);
    expect(init.code, init.err).toBe(0);
    const project = join(tmp, "my-bot");
    // Every dependency the new project names can be installed: no workspace: or unpublished ranges.
    if (existsSync(join(project, "package.json"))) {
      const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
      for (const [dep, range] of Object.entries<string>({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })) {
        expect(range.startsWith("workspace:"), `${dep}@${range}`).toBe(false);
        if (range.startsWith("file:")) {
          expect(existsSync(join(project, range.slice(5), "package.json"))).toBe(true);
        } else {
          expect(dep.startsWith("@zerosnake/") || dep === "zerosnake", `${dep}@${range}`).toBe(
            false,
          );
        }
      }
    }
    // Until the template has a bot (#15), bring one.
    if (!existsSync(join(project, "src", "bot.ts"))) {
      mkdirSync(join(project, "src"), { recursive: true });
      writeFileSync(join(project, "src", "bot.ts"), GOOD_BOT);
      writeFileSync(join(project, "src", "tuning.ts"), TUNING);
    }

    const sim = run("node", [bin, "sim", "--headless", "--ticks", "100", "--seed", "1"], project);
    expect(sim.code, sim.err).toBe(0);
    expect(sim.out).toContain("Match: seed 1, 100 ticks");
    expect(sim.out).toContain("my-bot (you)");
  }, 120_000);
});
