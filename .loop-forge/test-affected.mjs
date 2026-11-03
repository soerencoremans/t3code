// Loop-Forge's "test": the gate before an Auftrag's last ticket. Fork CI never runs (its
// blacksmith runners are upstream-only), so this gate is the only check a branch gets.
// Groups mirror ci.yml's Lint, Test, Test Web and Test Server jobs for the packages
// ci-changes.cjs maps the diff to; every group runs even after one fails.
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
const run = (...args) => ["run", ...args];
const groups = [];
const present = changed
  .split("\n")
  .filter((file) => file && NodeFS.existsSync(NodePath.join(root, file)));
if (present.length > 0) {
  groups.push(["format", ["fmt", "--check", "--no-error-on-unmatched-pattern", ...present]]);
  groups.push(["lint", ["lint", "--no-error-on-unmatched-pattern", ...present]]);
}
if (affected.length > 0) {
  groups.push(["typecheck", run("--concurrency-limit", "2", ...filters(affected), "typecheck")]);
}
if (outputs.test === "true") {
  const packages = outputs.test_packages ? outputs.test_packages.split(" ") : null;
  if (packages === null || packages.includes("@t3tools/desktop")) {
    groups.push(["electron", run("--filter", "@t3tools/desktop", "ensure:electron")]);
  }
  // Empty means every package the CI Test job covers.
  const testFilters = packages
    ? filters(packages)
    : filters(["!t3", "!@t3tools/monorepo", "!@t3tools/web"]);
  groups.push(["test", run("--parallel", "--concurrency-limit", "4", ...testFilters, "test")]);
}
if (outputs.test_web === "true") groups.push(["test web", run("--filter", "@t3tools/web", "test")]);
if (outputs.test_server === "true") groups.push(["test server", run("--filter", "t3", "test")]);

if (groups.length === 0) {
  console.log(`Nothing to check: the diff against ${baseRef} is empty.`);
  process.exit(0);
}

const results = [];
for (const [name, args] of groups) {
  console.log(`\n=== ${name}: vp ${args.join(" ")} ===`);
  const started = Date.now();
  const run = NodeChildProcess.spawnSync("vp", args, { cwd: root, stdio: "inherit" });
  results.push({ name, status: run.status, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log(`\n=== Gate summary (against ${baseRef}) ===`);
for (const { name, status, seconds } of results) {
  console.log(`${status === 0 ? "pass" : "FAIL"}  ${name} (${seconds}s)`);
}
process.exit(results.every((result) => result.status === 0) ? 0 : 1);
