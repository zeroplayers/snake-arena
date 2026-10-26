import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { CliError } from "./errors.ts";
import { initProject, packageName } from "./init.ts";
import { packageRoot } from "./paths.ts";
import { findTemplateDir } from "./template.ts";
import { captureIo, cleanUp, makeProject } from "./testing/project.ts";

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
    expect(result.files).toEqual([".gitignore", "CLAUDE.md", "package.json", "src/bot.ts"]);
    expect(existsSync(join(cwd, "my-snake/node_modules"))).toBe(false);
    expect(readFileSync(join(cwd, "my-snake/.gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("names the package after the folder and drops workspace: ranges", () => {
    const template = makeProject(TEMPLATE);
    const cwd = makeProject({});
    initProject("My Snake!", { cwd, templateDir: template });
    const pkg = JSON.parse(readFileSync(join(cwd, "My Snake!/package.json"), "utf8"));

    expect(pkg.name).toBe("my-snake");
    expect(pkg.dependencies["@zerosnake/sdk"]).toBe("^0.0.0");
    expect(pkg.devDependencies.zerosnake).toBe("^0.0.0");
    expect(pkg.devDependencies["@zerosnake/unknown"]).toBe("*");
    expect(pkg.devDependencies.vitest).toBe("^5.0.5");
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
    // dist/template once `pnpm build` ran, else the repo's template/ itself.
    const root = packageRoot();
    expect([join(root, "dist", "template"), join(root, "..", "..", "template")]).toContain(
      findTemplateDir(root),
    );
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
