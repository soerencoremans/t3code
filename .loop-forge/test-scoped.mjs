// Loop-Forge's "test-scoped": the Auftrag's own test files, for every ticket but its last.
//   node .loop-forge/test-scoped.mjs <file>…   repo-relative, as `git diff --name-only` prints them
//
// Files are run through their package's own `test` script, from that package, because
// apps/server, apps/web, apps/desktop and packages/client-runtime carry configs (setup
// files, projects, serial files) that a root-level `vp test run` would silently skip.
// Paths that are not test files, or that live outside a workspace package, are ignored.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.dirname(import.meta.dirname);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function owningPackage(file) {
  for (
    let dir = NodePath.dirname(NodePath.join(root, file));
    dir !== root;
    dir = NodePath.dirname(dir)
  ) {
    const manifestPath = NodePath.join(dir, "package.json");
    if (!NodeFS.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
    return manifest.scripts?.test ? { name: manifest.name, dir } : null;
  }
  return null;
}

const groups = new Map();
for (const file of process.argv.slice(2)) {
  if (!TEST_FILE.test(file) || !NodeFS.existsSync(NodePath.join(root, file))) continue;
  const pkg = owningPackage(file);
  if (pkg === null) {
    console.log(`skipped (no package test script): ${file}`);
    continue;
  }
  const group = groups.get(pkg.name) ?? [];
  group.push(NodePath.relative(pkg.dir, NodePath.join(root, file)));
  groups.set(pkg.name, group);
}

if (groups.size === 0) {
  console.log("No test files among the changed files.");
  process.exit(0);
}

const failed = [];
for (const [name, files] of groups) {
  console.log(`\n=== ${name}: ${files.join(" ")} ===`);
  const run = NodeChildProcess.spawnSync("vp", ["run", "--filter", name, "test", ...files], {
    cwd: root,
    stdio: "inherit",
  });
  if (run.status !== 0) failed.push(name);
}

console.log(failed.length === 0 ? "\nAll scoped tests passed." : `\nFailed: ${failed.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
