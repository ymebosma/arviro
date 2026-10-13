// `arviro service`: start Arviro at login and keep it running, and run the library update weekly.
// macOS: two LaunchAgents. Linux: a systemd user service and timer. Windows: a hidden launcher in the
// Startup folder and a scheduled task. Everything is per user; no administrator rights are needed.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ServiceError } from "./text.js";

const LABEL = "local.arviro";
const UPDATE_TASK = "Arviro library update";
// Node.js as the package managers link it: these paths survive an update, the versioned Cellar path does not.
const STABLE_NODE_PATHS = ["/opt/homebrew/opt/node/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The path to put in the service files for Node.js: a stable link to the running binary when there is one. */
export function stableNodePath(execPath = process.execPath, candidates = STABLE_NODE_PATHS) {
  let real;
  try { real = fs.realpathSync(execPath); } catch { return execPath; }
  for (const candidate of candidates) {
    try { if (fs.realpathSync(candidate) === real) return candidate; } catch {}
  }
  return execPath;
}

/** Open a URL in the default browser, quietly; a machine without a browser just keeps the URL in the log. */
export function openInBrowser(url, platform = process.platform) {
  const [command, args] = platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(label, programArguments, extra) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`arviro service install\`; \`arviro service uninstall\` removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
${extra}
</dict>
</plist>
`;
}

/** A command line for systemd's ExecStart: every argument double-quoted. */
const systemdCommand = (parts) => parts.map((part) => `"${String(part).replace(/[\\"]/g, "\\$&")}"`).join(" ");

/** A command line for cmd.exe and VBScript: arguments with spaces double-quoted. */
const windowsCommand = (parts) => parts.map((part) => (/[\s"]/.test(part) ? `"${String(part).replace(/"/g, '""')}"` : part)).join(" ");

/**
 * The files the service consists of on a platform, with their contents.
 * @returns {{ files: {path: string, content: string}[], logHint: string, lingerHint?: string }}
 */
export function serviceFiles({ platform = process.platform, nodePath, scriptPath, configPath, home = os.homedir(), appData = process.env.APPDATA, localAppData = process.env.LOCALAPPDATA, xdgConfigHome = process.env.XDG_CONFIG_HOME }) {
  const serve = [nodePath, scriptPath, "serve", "--no-open", "--config", configPath];
  const update = [nodePath, scriptPath, "library", "update", "--config", configPath];

  if (platform === "darwin") {
    const logs = path.join(home, "Library", "Logs");
    const agents = path.join(home, "Library", "LaunchAgents");
    return {
      files: [
        { path: path.join(agents, `${LABEL}.plist`), content: plist(LABEL, serve, `  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logs, "arviro.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logs, "arviro.log"))}</string>`) },
        { path: path.join(agents, `${LABEL}.library.plist`), content: plist(`${LABEL}.library`, update, `  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logs, "arviro-library.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logs, "arviro-library.log"))}</string>`) },
      ],
      logHint: `the log is ${path.join(logs, "arviro.log")}`,
    };
  }

  if (platform === "win32") {
    const startup = path.join(appData || path.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    const logFile = path.join(localAppData || path.join(home, "AppData", "Local"), "Arviro", "arviro.log");
    // cmd.exe runs the command without a window; VBScript doubles the quotes inside its string.
    const command = `cmd /c "${windowsCommand(serve)} >> ${windowsCommand([logFile])} 2>&1"`;
    return {
      files: [{ path: path.join(startup, "Arviro.vbs"), content: `' Written by "arviro service install"; "arviro service uninstall" removes it.\r\nCreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n` }],
      logHint: `the log is ${logFile}`,
      updateCommand: windowsCommand(update),
    };
  }

  const units = path.join(xdgConfigHome || path.join(home, ".config"), "systemd", "user");
  return {
    files: [
      { path: path.join(units, "arviro.service"), content: `# Written by \`arviro service install\`; \`arviro service uninstall\` removes it.
[Unit]
Description=Arviro: an offline library over MCP
After=network.target

[Service]
ExecStart=${systemdCommand(serve)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
` },
      { path: path.join(units, "arviro-library.service"), content: `# Written by \`arviro service install\`; started by arviro-library.timer.
[Unit]
Description=Arviro library update

[Service]
Type=oneshot
ExecStart=${systemdCommand(update)}
` },
      { path: path.join(units, "arviro-library.timer"), content: `# Written by \`arviro service install\`; \`arviro service uninstall\` removes it.
[Unit]
Description=Weekly Arviro library update

[Timer]
OnCalendar=Sun 04:00
Persistent=true

[Install]
WantedBy=timers.target
` },
    ],
    logHint: "the log is in the journal: journalctl --user -u arviro",
    lingerHint: "to keep it running when you are not logged in: loginctl enable-linger",
  };
}

/** Run a command and wait; the service commands are short. Throws a ServiceError when it fails, unless told to ignore that. */
export function runCommand(command, args, { ignoreFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if ((result.error || result.status !== 0) && !ignoreFailure) {
    const detail = result.error ? (result.error.code || result.error.message) : (result.stderr || result.stdout || "").trim().split("\n").at(-1) || `exit code ${result.status}`;
    throw new ServiceError(`${command} ${args[0] || ""} failed: ${detail}`);
  }
  return result;
}

/**
 * Write the service files and start the service. `run` executes a command (injected by the tests).
 * Returns the lines to show the owner.
 */
export async function installService(options, { run = runCommand, uid = typeof process.getuid === "function" ? process.getuid() : 0, sleep = sleepMs } = {}) {
  const { platform = process.platform } = options;
  const spec = serviceFiles(options);
  const lines = [];
  for (const file of spec.files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.content, { mode: 0o644 });
    lines.push(`wrote ${file.path}`);
  }
  if (platform === "darwin") {
    for (const file of spec.files) {
      const label = path.basename(file.path, ".plist");
      const domain = `gui/${uid}`;
      // A loaded agent must be unloaded before it can be loaded again (a reinstall); a fresh one is not loaded yet.
      // bootout returns before the agent is gone, and a bootstrap of the same label fails until it is: wait for that.
      run("launchctl", ["bootout", `${domain}/${label}`], { ignoreFailure: true });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const print = run("launchctl", ["print", `${domain}/${label}`], { ignoreFailure: true });
        if (print.error || print.status !== 0) break;
        await sleep(250);
      }
      let lastError = null;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try { run("launchctl", ["bootstrap", domain, file.path]); lastError = null; break; }
        catch (error) { lastError = error; await sleep(1000); }
      }
      if (lastError) throw new ServiceError(`${lastError.message}. The earlier agent may still be stopping; try again in a moment, or run: launchctl bootstrap ${domain} ${file.path}`);
    }
    lines.push("Arviro starts at login and runs now; the library update runs on Sunday at 04:00");
  } else if (platform === "win32") {
    run("schtasks", ["/Create", "/F", "/SC", "WEEKLY", "/D", "SUN", "/ST", "04:00", "/TN", UPDATE_TASK, "/TR", spec.updateCommand]);
    run("wscript", [spec.files[0].path]);
    lines.push(`Arviro starts at login and runs now; the scheduled task "${UPDATE_TASK}" runs on Sunday at 04:00`);
  } else {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "arviro.service", "arviro-library.timer"]);
    lines.push("Arviro starts at login and runs now; the library update runs on Sunday at 04:00");
    lines.push(spec.lingerHint);
  }
  lines.push(spec.logHint);
  return lines;
}

/** Stop the service and remove its files. Returns the lines to show the owner. */
export function uninstallService(options, { run = runCommand, uid = typeof process.getuid === "function" ? process.getuid() : 0 } = {}) {
  const { platform = process.platform } = options;
  const spec = serviceFiles(options);
  const lines = [];
  if (platform === "darwin") {
    for (const file of spec.files) run("launchctl", ["bootout", `gui/${uid}/${path.basename(file.path, ".plist")}`], { ignoreFailure: true });
  } else if (platform === "win32") {
    run("schtasks", ["/Delete", "/F", "/TN", UPDATE_TASK], { ignoreFailure: true });
    lines.push("a running Arviro keeps running until you log out or stop it");
  } else {
    run("systemctl", ["--user", "disable", "--now", "arviro.service", "arviro-library.timer"], { ignoreFailure: true });
  }
  for (const file of spec.files) {
    if (!fs.existsSync(file.path)) continue;
    fs.rmSync(file.path);
    lines.push(`removed ${file.path}`);
  }
  if (platform !== "darwin" && platform !== "win32") run("systemctl", ["--user", "daemon-reload"], { ignoreFailure: true });
  lines.push(lines.some((line) => line.startsWith("removed")) ? "Arviro no longer starts at login" : "the service was not installed");
  return lines;
}

/** Whether the service files are in place. Returns the lines to show the owner. */
export function serviceStatus(options) {
  const spec = serviceFiles(options);
  const lines = spec.files.map((file) => `${fs.existsSync(file.path) ? "installed" : "missing  "}  ${file.path}`);
  lines.push(spec.files.every((file) => fs.existsSync(file.path)) ? "Arviro starts at login" : "Arviro does not start at login; run: arviro service install");
  lines.push(spec.logHint);
  return lines;
}
