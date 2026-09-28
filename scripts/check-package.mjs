#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import console from "node:console";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runProcess } from "@uppercut-labs/cappy-internal-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "packages/cappy");
const args = process.argv.slice(2);
const tarballArg = args[0] === "--tarball" ? args[1] : undefined;
if (args.some((arg, index) => arg === "--tarball" && index !== 0) || (args.length !== 0 && (args.length !== 2 || args[0] !== "--tarball")) || (args[0] === "--tarball" && tarballArg === undefined)) {
  throw new Error("Usage: node scripts/check-package.mjs [--tarball <path>]");
}

const scratch = await mkdtemp(path.join(os.tmpdir(), "cappy-package-check-"));
let tarball = tarballArg === undefined ? undefined : path.resolve(tarballArg);

function command(bin, commandArgs, options = {}) {
  return runProcess(bin, commandArgs, { cwd: options.cwd, env: options.env }).then((result) => {
    if (result.spawnError !== undefined) throw new Error(`Could not start ${bin}: ${result.spawnError}`);
    return { code: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
  });
}

async function checked(bin, commandArgs, options = {}) {
  const result = await command(bin, commandArgs, options);
  if (result.code !== 0) {
    throw new Error(`${bin} ${commandArgs.join(" ")} failed (${result.code ?? result.signal}):\n${result.stderr || result.stdout}`);
  }
  return result;
}

async function checkedNpm(commandArgs, options = {}) {
  if (process.platform !== "win32") return checked("npm", commandArgs, options);
  const npmCli = process.env["npm_execpath"] ?? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  try {
    await access(npmCli);
  } catch (cause) {
    throw new Error(`Cannot locate npm CLI for isolated Windows package checks: ${npmCli}`, { cause });
  }
  return checked(process.execPath, [npmCli, ...commandArgs], options);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonResult(output, label) {
  try {
    return JSON.parse(output);
  } catch (cause) {
    throw new Error(`${label} did not return valid JSON: ${cause.message}\n${output}`, { cause });
  }
}

async function runCli(launcher, commandArgs, cwd) {
  return command(launcher, commandArgs, { cwd });
}

function parseJsonEnvelope(output, label) {
  const result = jsonResult(output.trim(), label);
  assert(result && typeof result === "object" && typeof result.ok === "boolean", `${label} did not return a Cappy JSON result`);
  return result;
}

async function waitForSession(project, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = path.join(project, ".cappy/sessions");
    try {
      for (const entry of await readdir(sessions, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(sessions, entry.name, "session.json");
        try {
          const session = JSON.parse(await readFile(file, "utf8"));
          if (session.status === "active") return { file, session };
        } catch (cause) {
          if (cause.code !== "ENOENT") throw cause;
        }
      }
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    await delay(100);
  }
  throw new Error("record did not create an active fixture session in time");
}

try {
  if (tarball === undefined) {
    const packOutput = await checkedNpm(["pack", "--json", "--pack-destination", scratch, packageDir], { cwd: root });
    const [packed] = jsonResult(packOutput.stdout, "npm pack");
    assert(typeof packed?.filename === "string", "npm pack did not report a tarball filename");
    tarball = path.join(scratch, packed.filename);
  }
  await access(tarball);

  const listing = await checked("tar", ["-tzf", tarball]);
  const members = listing.stdout.split(/\r?\n/).filter(Boolean);
  assert(members.length > 0 && members.every((name) => name.startsWith("package/")), "tarball does not contain a single package/ root");
  for (const forbidden of ["test", "tests", "fixture", "fixtures", ".env", "cappy.config.json", "node_modules"]) {
    assert(!members.some((name) => name.toLowerCase().includes(forbidden)), `tarball unexpectedly contains ${forbidden}`);
  }

  const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
  const installRoot = path.join(scratch, "consumer");
  const globalPrefix = path.join(scratch, "global");
  await mkdir(installRoot, { recursive: true });
  await mkdir(globalPrefix, { recursive: true });
  await checkedNpm(["install", "--prefix", installRoot, "--no-save", "--ignore-scripts", tarball], { cwd: scratch });
  const installedPackage = JSON.parse(await readFile(path.join(installRoot, "node_modules/@uppercut-labs/cappy/package.json"), "utf8"));
  assert(installedPackage.name === "@uppercut-labs/cappy" && installedPackage.private !== true, "tarball manifest is not the public package");
  assert(installedPackage.engines?.node === ">=24", "package must require Node.js >=24");
  assert(installedPackage.bin?.cappy, "public package manifest must provide the cappy executable");
  const runtimeDependencies = installedPackage.dependencies ?? {};
  assert(Object.keys(runtimeDependencies).sort().join(",") === "ws,zod", `unexpected runtime dependency set: ${Object.keys(runtimeDependencies).join(", ")}`);
  for (const value of Object.values(runtimeDependencies)) {
    assert(typeof value === "string" && !/(^file:|^workspace:|^link:|\.tgz$)/.test(value), `local or private dependency reference found: ${value}`);
  }
  const dependencyTree = jsonResult((await checkedNpm(["ls", "--prefix", installRoot, "--omit=dev", "--all", "--json"])).stdout, "npm ls");
  function inspectDependencies(dependencies, isPackageRoot = false) {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      assert(!name.includes("internal-") && !name.includes("fixture-"), `private workspace leaked into installation: ${name}`);
      assert(dependency.link !== true, `installed dependency is a workspace link: ${name}`);
      if (!(isPackageRoot && name === "@uppercut-labs/cappy")) {
        assert(!/^(file:|workspace:|link:)/.test(dependency.resolved ?? ""), `installed dependency resolves locally: ${name} (${dependency.resolved})`);
      }
      inspectDependencies(dependency.dependencies, false);
    }
  }
  inspectDependencies(dependencyTree.dependencies, true);

  const projectLauncher = path.join(installRoot, "node_modules/.bin", process.platform === "win32" ? "cappy.cmd" : "cappy");
  const projectPackageLauncher = path.join(installRoot, "node_modules/@uppercut-labs/cappy", installedPackage.bin.cappy);
  await access(process.platform === "win32" ? projectLauncher : projectPackageLauncher);
  const help = await runCli(projectLauncher, ["--help"], installRoot);
  assert(help.code === 0 && help.stdout.includes("Usage: cappy"), "installed local cappy --help launcher failed");
  const version = await runCli(projectLauncher, ["--version"], installRoot);
  assert(version.code === 0 && version.stdout.trim() === installedPackage.version, "installed local cappy --version does not match the package version");

  const empty = path.join(scratch, "empty-project");
  await mkdir(empty, { recursive: true });
  const missingConfig = await runCli(projectLauncher, ["doctor", "--json", "-C", empty], empty);
  const missing = parseJsonEnvelope(missingConfig.stdout, "doctor missing-config JSON");
  assert(missingConfig.code === 3 && !missing.ok && missing.error.code === "CONFIG_NOT_FOUND", "missing configuration must return CONFIG_NOT_FOUND (exit 3)");

  const simulator = path.join(root, "fixtures/adapter-simulator/dist/bin.js");
  await access(simulator);
  const project = path.join(scratch, "fixture-project");
  await mkdir(project, { recursive: true });
  const config = {
    schemaVersion: 1,
    project: { id: "package-check", name: "Package Check" },
    game: { command: process.execPath, args: [simulator] },
    adapter: { port: 0 },
    obs: { url: "ws://127.0.0.1:1", scene: "Capture" },
    tools: { ffmpeg: "cappy-check-missing-ffmpeg", ffprobe: "cappy-check-missing-ffprobe" },
    timeouts: { connectMs: 5_000, readyMs: 5_000, obsMs: 1_000, processMs: 60_000 },
  };
  await writeFile(path.join(project, "cappy.config.json"), JSON.stringify(config));
  const doctor = await runCli(projectLauncher, ["doctor", "--json", "-C", project], project);
  const doctorResult = parseJsonEnvelope(doctor.stdout, "doctor controlled-project JSON");
  assert(doctor.code === 4 && !doctorResult.ok && doctorResult.error.code === "DOCTOR_CHECKS_FAILED", `doctor with absent tools/OBS must return DOCTOR_CHECKS_FAILED (exit 4); got exit ${doctor.code}, ${JSON.stringify(doctorResult.error)}`);
  assert(Array.isArray(doctorResult.data?.checks) && doctorResult.data.checks.some((check) => check.status === "fail"), `doctor did not report individual missing-tool checks: ${JSON.stringify(doctorResult.data?.checks)}`);

  const scenarios = await runCli(projectLauncher, ["scenarios", "--json", "-C", project], project);
  const scenarioResult = parseJsonEnvelope(scenarios.stdout, "fixture scenarios JSON");
  assert(scenarios.code === 0 && scenarioResult.ok && Array.isArray(scenarioResult.data?.scenarios) && scenarioResult.data.scenarios.length > 0, "installed CLI could not discover the fixture scenario");
  const recorded = await runCli(projectLauncher, ["record", "--duration", "0.2", "--json", "-C", project], project);
  const recordResult = parseJsonEnvelope(recorded.stdout, "fixture record JSON");
  assert(recorded.code === 0 && recordResult.ok && recordResult.data?.replayable === true, "installed CLI could not record a replayable fixture session");
  const sessionId = recordResult.data.session.id;
  const replayed = await runCli(projectLauncher, ["replay", sessionId, "--no-capture", "--json", "-C", project], project);
  const replayResult = parseJsonEnvelope(replayed.stdout, "fixture no-capture replay JSON");
  assert(replayed.code === 0 && replayResult.ok && replayResult.data?.captured === false, "installed CLI could not replay a fixture session without capture");

  if (process.platform !== "win32") {
    const cancelProcess = await new Promise((resolve, reject) => {
      const child = spawn(projectLauncher, ["record", "--duration", "30", "--json", "-C", project], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ child, code, signal, stdout, stderr }));
      void (async () => {
        await waitForSession(project, 10_000);
        child.kill("SIGINT");
      })().catch(reject);
    });
    assert(cancelProcess.code === 130, `installed record cancellation exited ${cancelProcess.code ?? cancelProcess.signal}, expected 130: ${cancelProcess.stderr}`);
    const cancellation = parseJsonEnvelope(cancelProcess.stdout, "fixture cancellation JSON");
    assert(!cancellation.ok && cancellation.error.code === "OPERATION_CANCELLED", "cancelled fixture session did not report OPERATION_CANCELLED");
    assert(cancellation.data?.session?.status === "cancelled", "cancelled fixture session was not persisted as cancelled");
  } else {
    await checked("powershell", [
      "-NoProfile",
      "-File",
      path.join(root, "scripts/acceptance/windows-package-ctrl-c.ps1"),
      "-EntryPoint",
      projectPackageLauncher,
      "-Simulator",
      simulator,
    ], { cwd: project });
  }

  await checkedNpm(["install", "--prefix", globalPrefix, "--global", "--ignore-scripts", tarball], { cwd: scratch });
  const globalLauncher = process.platform === "win32"
    ? path.join(globalPrefix, "cappy.cmd")
    : path.join(globalPrefix, "bin/cappy");
  await access(globalLauncher);
  const globalHelp = await runCli(globalLauncher, ["--help"], scratch);
  assert(globalHelp.code === 0 && globalHelp.stdout.includes("Usage: cappy"), "npm-generated global cappy launcher failed --help");
  const globalVersion = await runCli(globalLauncher, ["--version"], scratch);
  assert(globalVersion.code === 0 && globalVersion.stdout.trim() === installedPackage.version, "global cappy --version does not match the package version");

  console.log(JSON.stringify({
    package: installedPackage.name,
    version: installedPackage.version,
    tarball: path.basename(tarball),
    sha256: digest,
    files: members.length,
    normalInstall: "passed",
    globalInstall: "passed",
    fixtureScenarios: "passed",
    recordReplayNoCapture: "passed",
    cancellation: "passed",
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
