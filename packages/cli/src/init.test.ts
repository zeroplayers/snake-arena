import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { templateDir } from "./assets.ts";
import { bundleBot } from "./bundle.ts";
import { main } from "./cli.ts";
import { CliError } from "./errors.ts";
import { initProject, PUBLISHED, packageName, VENDORED_SDK } from "./init.ts";
import { packageRoot } from "./paths.ts";
import { captureIo, cleanUp, GOOD_BOT, makeProject, TUNING } from "./testing/project.ts";

afterAll(cleanUp);

const TEMPLATE = {
  "package.json": JSON.stringify({
    name: "zerosnake-bot",
    private: true,
    dependencies: { "@zerosnake/sdk": "workspace:*" },
    devDependencies: {
      zerosnake: "workspace:*",
      "@zerosnake/unknown": "workspace:^",
      vitest: "^5.0.5",
    },
  }),
  "src/bot.ts": "export default {};\n",
  "CLAUDE.md": "# Rules\n",
  "MAINTAINING.md": "# For the monorepo only\n",
  gitignore: "node_modules/\n",
  "node_modules/junk/index.js": "",
  "dist/bot.js": "",
  ".DS_Store": "",
};

describe("initProject", () => {
  it("copies the template, minus installs and build output", () => {
    const template = makeProject(TEMPLATE);
    const cwd = makeProject({});
    const result = initProject("my-snake", { cwd, templateDir: template });

    expect(result.dir).toBe(join(cwd, "my-snake"));
    expect(result.files.filter((f) => !f.startsWith("vendor/"))).toEqual([
      ".gitignore",
      "CLAUDE.md",
      "package.json",
      "src/bot.ts",
    ]);
    expect(existsSync(join(cwd, "my-snake/node_modules"))).toBe(false);
    expect(readFileSync(join(cwd, "my-snake/.gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("names the package after the folder and makes every dependency installable", () => {
    const template = makeProject(TEMPLATE);
    const cwd = makeProject({});
    const result = initProject("My Snake!", { cwd, templateDir: template });
    const dir = join(cwd, "My Snake!");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

    expect(pkg.name).toBe("my-snake");
    // Nothing is on npm yet: the SDK is vendored, the rest left out (and reported).
    expect(pkg.dependencies).toEqual({ "@zerosnake/sdk": `file:${VENDORED_SDK}` });
    expect(pkg.devDependencies).toEqual({ vitest: "^5.0.5" });
    expect(result.omitted).toEqual(["@zerosnake/unknown", "zerosnake"]);

    const sdk = join(dir, VENDORED_SDK);
    const sdkPkg = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
    expect(sdkPkg).toMatchObject({ name: "@zerosnake/sdk", exports: "./src/index.ts" });
    expect(readdirSync(join(sdk, "src")).sort()).toEqual([
      "bot.ts",
      "geometry.ts",
      "index.ts",
      "log.ts",
      "types.ts",
    ]);
    expect(result.files).toContain(`${VENDORED_SDK}/src/index.ts`);
  });

  it("bundles a bot against the vendored SDK", async () => {
    const template = makeProject(TEMPLATE);
    const cwd = makeProject({});
    initProject("bot", { cwd, templateDir: template });
    // As after `npm install`: the file: dependency is linked into node_modules.
    const dir = join(cwd, "bot");
    mkdirSync(join(dir, "node_modules/@zerosnake"), { recursive: true });
    symlinkSync(join(dir, VENDORED_SDK), join(dir, "node_modules/@zerosnake/sdk"));
    writeFileSync(join(dir, "src/bot.ts"), GOOD_BOT);
    writeFileSync(join(dir, "src/tuning.ts"), TUNING);
    const bot = await bundleBot("src/bot.ts", { cwd: dir });
    expect(bot.code).toContain("steerToward");
  });

  it("writes ^version for packages on npm", () => {
    const template = makeProject({
      "package.json": JSON.stringify({ dependencies: { "@zerosnake/sdk": "workspace:*" } }),
    });
    const published = PUBLISHED as Set<string>;
    published.add("@zerosnake/sdk");
    try {
      const cwd = makeProject({});
      initProject("bot", { cwd, templateDir: template });
      const pkg = JSON.parse(readFileSync(join(cwd, "bot/package.json"), "utf8"));
      expect(pkg.dependencies["@zerosnake/sdk"]).toBe("^0.0.0");
    } finally {
      published.delete("@zerosnake/sdk");
    }
  });

  it("adds a .gitignore when the template has none", () => {
    const template = makeProject({ "src/bot.ts": "" });
    const cwd = makeProject({});
    const result = initProject("bot", { cwd, templateDir: template });
    expect(result.files).toContain(".gitignore");
  });

  it("refuses a folder that isn't empty", () => {
    const template = makeProject(TEMPLATE);
    const cwd = makeProject({ "taken/notes.txt": "mine" });
    expect(() => initProject("taken", { cwd, templateDir: template })).toThrow(CliError);
    expect(readFileSync(join(cwd, "taken/notes.txt"), "utf8")).toBe("mine");
  });

  it("accepts an empty folder (or one with just .git)", () => {
    const template = makeProject(TEMPLATE);
    const cwd = makeProject({ "here/.git/HEAD": "ref: refs/heads/main\n" });
    expect(initProject("here", { cwd, templateDir: template }).files).toContain("src/bot.ts");
  });

  it("finds the repo's template/ from a source checkout", () => {
    expect(templateDir()).toBe(join(packageRoot(), "..", "..", "template"));
  });
});

describe("zerosnake init", () => {
  it("scaffolds from the bundled template and prints the next steps", async () => {
    const cwd = makeProject({});
    const io = captureIo(cwd);
    expect(await main(["init", "my-bot"], io)).toBe(0);
    expect(io.stdout()).toContain("Created my-bot");
    expect(io.stdout()).toContain("cd my-bot");
    expect(io.stdout()).toContain("npx zerosnake sim");
    expect(readdirSync(join(cwd, "my-bot")).length).toBeGreaterThan(1);
  });

  it("scaffolds a bot that passes `zerosnake test` on its own seeds", async () => {
    // An author's first `init` + `test` (+ `deploy`) plays the seeds of the template bot's bundle
    // exactly as `init` copies it. Any edit to the bot, the SDK or the game re-rolls them, and the
    // bot passes by a margin on almost every seed set but not all (template/MAINTAINING.md): this
    // catches an edit that lands on one of those.
    const cwd = makeProject({});
    expect(await main(["init", "first-bot"], captureIo(cwd))).toBe(0);
    // As after `npm install`: the file: dependency is linked into node_modules.
    const dir = join(cwd, "first-bot");
    mkdirSync(join(dir, "node_modules/@zerosnake"), { recursive: true });
    symlinkSync(join(dir, VENDORED_SDK), join(dir, "node_modules/@zerosnake/sdk"));
    const io = captureIo(dir);
    expect(await main(["test"], io)).toBe(0);
    expect(io.stdout()).toContain("Ready to deploy");
  }, 120_000);

  it("is a usage error without a folder", async () => {
    const io = captureIo(makeProject({}));
    expect(await main(["init"], io)).toBe(2);
    expect(io.stderr()).toContain("zerosnake init <dir>");
  });
});

describe("packageName", () => {
  it.each([
    ["my-snake", "my-snake"],
    ["My Snake", "my-snake"],
    ["__x__", "x"],
    ["!!!", "zerosnake-bot"],
  ])("%s → %s", (folder, name) => {
    expect(packageName(folder)).toBe(name);
  });
});
