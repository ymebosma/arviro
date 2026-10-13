import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { installService, serviceFiles, serviceStatus, stableNodePath, uninstallService } from "../src/service.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "arviro-service-test-"));
after(() => fs.rmSync(home, { recursive: true, force: true }));

// Paths with spaces, to check the quoting on every platform.
const target = (platform) => ({
  platform,
  nodePath: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/opt/homebrew/bin/node",
  scriptPath: platform === "win32" ? "C:\\Users\\Someone\\My Arviro\\bin\\arviro.js" : path.join(home, "my arviro", "bin", "arviro.js"),
  configPath: platform === "win32" ? "C:\\Users\\Someone\\.config\\arviro\\config.json" : path.join(home, ".config", "arviro", "config.json"),
  home,
  appData: path.join(home, "Roaming"),
  localAppData: path.join(home, "Local"),
  // The test's home decides where the files go, not this machine's environment (CI sets XDG_CONFIG_HOME).
  xdgConfigHome: "",
});

/**
 * A stand-in for running commands: records them, fails the ones in `failing`. `launchctl print` says the agent is
 * gone (exit 113) after `busy` calls; `launchctl bootstrap` fails `bootstrapFailures` times before it succeeds.
 */
function recorder(failing = [], { busy = 0, bootstrapFailures = 0 } = {}) {
  const calls = [];
  const sleeps = [];
  let printCalls = 0;
  let bootstrapCalls = 0;
  const run = (command, args, { ignoreFailure = false } = {}) => {
    calls.push([command, ...args]);
    if (failing.includes(command) && !ignoreFailure) throw new Error(`${command} failed`);
    if (command === "launchctl" && args[0] === "print") return { status: (printCalls += 1) > busy ? 113 : 0 };
    if (command === "launchctl" && args[0] === "bootstrap" && (bootstrapCalls += 1) <= bootstrapFailures) throw new Error("launchctl bootstrap failed: Try re-running the command as root for richer errors.");
    return { status: 0 };
  };
  const sleep = async (ms) => { sleeps.push(ms); };
  return { calls, sleeps, run, sleep };
}

test("macOS: two LaunchAgents, loaded with launchctl", async () => {
  const spec = serviceFiles(target("darwin"));
  assert.deepEqual(spec.files.map((file) => path.relative(home, file.path)), ["Library/LaunchAgents/local.arviro.plist", "Library/LaunchAgents/local.arviro.library.plist"]);
  const [serve, update] = spec.files.map((file) => file.content);
  assert.match(serve, /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>[^<]*my arviro\/bin\/arviro.js<\/string>\s*<string>serve<\/string>\s*<string>--no-open<\/string>\s*<string>--config<\/string>/);
  assert.match(serve, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(update, /<string>library<\/string>\s*<string>update<\/string>/);
  assert.match(update, /<key>Weekday<\/key>\s*<integer>0<\/integer>/);

  const { calls, sleeps, run, sleep } = recorder();
  const lines = await installService(target("darwin"), { run, uid: 501, sleep });
  assert.ok(fs.existsSync(spec.files[0].path) && fs.existsSync(spec.files[1].path));
  assert.deepEqual(calls, [
    ["launchctl", "bootout", "gui/501/local.arviro"],
    ["launchctl", "print", "gui/501/local.arviro"],
    ["launchctl", "bootstrap", "gui/501", spec.files[0].path],
    ["launchctl", "bootout", "gui/501/local.arviro.library"],
    ["launchctl", "print", "gui/501/local.arviro.library"],
    ["launchctl", "bootstrap", "gui/501", spec.files[1].path],
  ]);
  assert.deepEqual(sleeps, [], "an agent that is gone needs no waiting");
  assert.ok(lines.some((line) => /starts at login/.test(line)));
  assert.match(serviceStatus(target("darwin")).join("\n"), /installed .*local\.arviro\.plist[\s\S]*Arviro starts at login/);

  const removal = recorder();
  const removed = uninstallService(target("darwin"), { run: removal.run, uid: 501 });
  assert.equal(fs.existsSync(spec.files[0].path), false);
  assert.deepEqual(removal.calls.map((call) => call.slice(0, 2)), [["launchctl", "bootout"], ["launchctl", "bootout"]]);
  assert.ok(removed.some((line) => /no longer starts at login/.test(line)));
  assert.match(serviceStatus(target("darwin")).join("\n"), /missing/);
  assert.ok(uninstallService(target("darwin"), { run: removal.run, uid: 501 }).some((line) => /was not installed/.test(line)));
});

test("macOS: a reinstall waits for the running agent to stop and tries the bootstrap again", async () => {
  // bootout returns at once; the agent is still there for two checks, and the first bootstrap comes too early.
  const busy = recorder([], { busy: 2, bootstrapFailures: 1 });
  await installService(target("darwin"), { run: busy.run, uid: 501, sleep: busy.sleep });
  const forServe = busy.calls.filter((call) => call.at(-1).endsWith("local.arviro") || call.at(-1).endsWith("local.arviro.plist"));
  assert.deepEqual(forServe.map((call) => call[1]), ["bootout", "print", "print", "print", "bootstrap", "bootstrap"]);
  assert.deepEqual(busy.sleeps, [250, 250, 1000]);

  const stuck = recorder([], { bootstrapFailures: 99 });
  await assert.rejects(installService(target("darwin"), { run: stuck.run, uid: 501, sleep: stuck.sleep }), /still be stopping.*launchctl bootstrap gui\/501/);
  assert.equal(stuck.calls.filter((call) => call[1] === "bootstrap").length, 5);
});

test("the service uses a stable path to Node.js when the package manager provides one", () => {
  const real = path.join(home, "Cellar", "node", "26.0.0", "bin", "node");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "");
  const link = path.join(home, "opt", "node", "bin", "node");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  const other = path.join(home, "other-node");
  fs.writeFileSync(other, "");
  assert.equal(stableNodePath(real, [path.join(home, "nowhere"), other, link]), link);
  assert.equal(stableNodePath(real, [other]), real, "another Node.js is not the one that runs");
  assert.equal(stableNodePath(path.join(home, "missing"), [link]), path.join(home, "missing"));
});

test("Linux: a systemd user service and a weekly timer", async () => {
  const spec = serviceFiles(target("linux"));
  assert.deepEqual(spec.files.map((file) => path.relative(home, file.path)), [".config/systemd/user/arviro.service", ".config/systemd/user/arviro-library.service", ".config/systemd/user/arviro-library.timer"]);
  const [serve, update, timer] = spec.files.map((file) => file.content);
  assert.match(serve, /^ExecStart="\/opt\/homebrew\/bin\/node" "[^"]*my arviro\/bin\/arviro\.js" "serve" "--no-open" "--config" "[^"]*config\.json"$/m);
  assert.match(serve, /^Restart=always$/m);
  assert.match(update, /^Type=oneshot$/m);
  assert.match(update, /"library" "update"/);
  assert.match(timer, /^OnCalendar=Sun 04:00$/m);

  const { calls, run } = recorder();
  await installService(target("linux"), { run });
  assert.deepEqual(calls, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "arviro.service", "arviro-library.timer"],
  ]);
  assert.ok(spec.files.every((file) => fs.existsSync(file.path)));
  const removal = recorder(["systemctl"]);
  // A failing systemctl (no systemd on this machine) does not stop the removal of the files.
  uninstallService(target("linux"), { run: removal.run });
  assert.ok(spec.files.every((file) => !fs.existsSync(file.path)));
});

test("Windows: a hidden launcher in the Startup folder and a scheduled task", async () => {
  const spec = serviceFiles(target("win32"));
  assert.equal(path.relative(home, spec.files[0].path), path.join("Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Arviro.vbs"));
  const vbs = spec.files[0].content;
  // VBScript doubles quotes inside a string; cmd gets the whole command in quotes, with every path that has a space quoted.
  const launch = vbs.match(/^CreateObject\("WScript\.Shell"\)\.Run "(.*)", 0, False\r$/m);
  assert.ok(launch, vbs);
  const logFile = path.join(home, "Local", "Arviro", "arviro.log");
  assert.equal(launch[1].replace(/""/g, '"'), `cmd /c ""C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Someone\\My Arviro\\bin\\arviro.js" serve --no-open --config C:\\Users\\Someone\\.config\\arviro\\config.json >> ${logFile} 2>&1"`);
  assert.equal(spec.updateCommand, '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Someone\\My Arviro\\bin\\arviro.js" library update --config C:\\Users\\Someone\\.config\\arviro\\config.json');

  const { calls, run } = recorder();
  await installService(target("win32"), { run });
  assert.deepEqual(calls, [
    ["schtasks", "/Create", "/F", "/SC", "WEEKLY", "/D", "SUN", "/ST", "04:00", "/TN", "Arviro library update", "/TR", spec.updateCommand],
    ["wscript", spec.files[0].path],
  ]);
  const removal = recorder();
  uninstallService(target("win32"), { run: removal.run });
  assert.deepEqual(removal.calls[0], ["schtasks", "/Delete", "/F", "/TN", "Arviro library update"]);
  assert.equal(fs.existsSync(spec.files[0].path), false);
});

test("a failing command is reported as a service problem", async () => {
  const { run } = recorder(["systemctl"]);
  await assert.rejects(installService(target("linux"), { run }), /systemctl failed/);
});
