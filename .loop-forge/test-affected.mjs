// Loop-Forge's "test": the gate before an Auftrag's last ticket.
//   node .loop-forge/test-affected.mjs
//
// Tests and typechecks the packages the branch affects, as CI does for a pull request:
// .github/scripts/ci-changes.cjs maps the diff against the base branch to packages and their
// dependents, and the groups below mirror the Test, Test Web and Test Server jobs in
// .github/workflows/ci.yml. Unlike `vp run -r`, every group runs even after one fails.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const root = NodePath.dirname(import.meta.dirname);

function readConfig(name) {
  const file = NodePath.join(root, ".loop-forge", name);
  return NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : null;
}

function git(...args) {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: result.status === 0, out: result.stdout.trim() };
}

function must(result, what) {
  if (!result.ok) {
    console.error(`Could not ${what}.`);
    process.exit(2);
  }
  return result.out;
}

// The same ref Loop-Forge measures an Auftrag against: origin's copy of the base branch, if any.
const base =
  (readConfig("config.json") ?? readConfig("config-example.json"))?.["base-branch"] ?? "main";
const baseRef = git("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`).ok
  ? `origin/${base}`
  : base;
const mergeBase = must(git("merge-base", baseRef, "HEAD"), `find the merge base with ${baseRef}`);
const changed = must(
  git("diff", "--name-only", "--no-renames", mergeBase, "HEAD"),
  `diff against ${baseRef}`,
);

const pathsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-loop-gate-"));
const pathsFile = NodePath.join(pathsDir, "paths");
NodeFS.writeFileSync(pathsFile, changed);
const detect = NodeChildProcess.spawnSync(
  "node",
  [".github/scripts/ci-changes.cjs", "--paths", pathsFile],
  { cwd: root, encoding: "utf8" },
);
NodeFS.rmSync(pathsDir, { recursive: true });
process.stderr.write(detect.stderr);
if (detect.status !== 0) process.exit(2);

const outputs = Object.fromEntries(
  detect.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
const affectedLine = detect.stderr.match(/^Affected packages: (.*)$/m)?.[1] ?? "none";
const affected = affectedLine === "none" ? [] : affectedLine.split(", ");

const filters = (names) => names.flatMap((name) => ["--filter", name]);
const groups = [];
if (affected.length > 0) {
  groups.push(["typecheck", ["--concurrency-limit", "2", ...filters(affected), "typecheck"]]);
}
if (outputs.test === "true") {
  const packages = outputs.test_packages ? outputs.test_packages.split(" ") : null;
  if (packages === null || packages.includes("@t3tools/desktop")) {
    groups.push(["electron", ["--filter", "@t3tools/desktop", "ensure:electron"]]);
  }
  // Empty means every package the CI Test job covers.
  const testFilters = packages
    ? filters(packages)
    : filters(["!t3", "!@t3tools/monorepo", "!@t3tools/web"]);
  groups.push(["test", ["--parallel", "--concurrency-limit", "4", ...testFilters, "test"]]);
}
if (outputs.test_web === "true") groups.push(["test web", ["--filter", "@t3tools/web", "test"]]);
if (outputs.test_server === "true") groups.push(["test server", ["--filter", "t3", "test"]]);

if (groups.length === 0) {
  console.log(`Nothing to test: no package is affected by the diff against ${baseRef}.`);
  process.exit(0);
}

const results = [];
for (const [name, args] of groups) {
  console.log(`\n=== ${name}: vp run ${args.join(" ")} ===`);
  const started = Date.now();
  const run = NodeChildProcess.spawnSync("vp", ["run", ...args], { cwd: root, stdio: "inherit" });
  results.push({ name, status: run.status, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log(`\n=== Gate summary (against ${baseRef}) ===`);
for (const { name, status, seconds } of results) {
  console.log(`${status === 0 ? "pass" : "FAIL"}  ${name} (${seconds}s)`);
}
process.exit(results.every((result) => result.status === 0) ? 0 : 1);
