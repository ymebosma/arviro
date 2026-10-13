import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { installService, serviceFiles, serviceStatus, uninstallService } from "../src/service.js";

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

/** A stand-in for running commands: records them, fails the ones in `failing`. */
function recorder(failing = []) {
  const calls = [];
  const run = (command, args, { ignoreFailure = false } = {}) => {
    calls.push([command, ...args]);
    if (failing.includes(command) && !ignoreFailure) throw new Error(`${command} failed`);
    return { status: 0 };
  };
  return { calls, run };
}

test("macOS: two LaunchAgents, loaded with launchctl", () => {
  const spec = serviceFiles(target("darwin"));
  assert.deepEqual(spec.files.map((file) => path.relative(home, file.path)), ["Library/LaunchAgents/local.arviro.plist", "Library/LaunchAgents/local.arviro.library.plist"]);
  const [serve, update] = spec.files.map((file) => file.content);
  assert.match(serve, /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>[^<]*my arviro\/bin\/arviro.js<\/string>\s*<string>serve<\/string>\s*<string>--no-open<\/string>\s*<string>--config<\/string>/);
  assert.match(serve, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(update, /<string>library<\/string>\s*<string>update<\/string>/);
  assert.match(update, /<key>Weekday<\/key>\s*<integer>0<\/integer>/);

  const { calls, run } = recorder();
  const lines = installService(target("darwin"), { run, uid: 501 });
  assert.ok(fs.existsSync(spec.files[0].path) && fs.existsSync(spec.files[1].path));
  assert.deepEqual(calls, [
    ["launchctl", "bootout", "gui/501/local.arviro"],
    ["launchctl", "bootstrap", "gui/501", spec.files[0].path],
    ["launchctl", "bootout", "gui/501/local.arviro.library"],
    ["launchctl", "bootstrap", "gui/501", spec.files[1].path],
  ]);
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

test("Linux: a systemd user service and a weekly timer", () => {
  const spec = serviceFiles(target("linux"));
  assert.deepEqual(spec.files.map((file) => path.relative(home, file.path)), [".config/systemd/user/arviro.service", ".config/systemd/user/arviro-library.service", ".config/systemd/user/arviro-library.timer"]);
  const [serve, update, timer] = spec.files.map((file) => file.content);
  assert.match(serve, /^ExecStart="\/opt\/homebrew\/bin\/node" "[^"]*my arviro\/bin\/arviro\.js" "serve" "--no-open" "--config" "[^"]*config\.json"$/m);
  assert.match(serve, /^Restart=always$/m);
  assert.match(update, /^Type=oneshot$/m);
  assert.match(update, /"library" "update"/);
  assert.match(timer, /^OnCalendar=Sun 04:00$/m);

  const { calls, run } = recorder();
  installService(target("linux"), { run });
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

test("Windows: a hidden launcher in the Startup folder and a scheduled task", () => {
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
  installService(target("win32"), { run });
  assert.deepEqual(calls, [
    ["schtasks", "/Create", "/F", "/SC", "WEEKLY", "/D", "SUN", "/ST", "04:00", "/TN", "Arviro library update", "/TR", spec.updateCommand],
    ["wscript", spec.files[0].path],
  ]);
  const removal = recorder();
  uninstallService(target("win32"), { run: removal.run });
  assert.deepEqual(removal.calls[0], ["schtasks", "/Delete", "/F", "/TN", "Arviro library update"]);
  assert.equal(fs.existsSync(spec.files[0].path), false);
});

test("a failing command is reported as a service problem", () => {
  const { run } = recorder(["launchctl"]);
  assert.throws(() => installService(target("darwin"), { run, uid: 501 }), /launchctl failed/);
});
