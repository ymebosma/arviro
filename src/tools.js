// Helper programs that Arviro can fetch by itself: kiwix-tools (kiwix-serve) comes as a plain archive
// per platform from download.kiwix.org, so it needs no package manager and no administrator.
// Everything else (poppler, osmium-tool, Ollama) comes from the platform's package manager; see setup.js.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { ServiceError } from "./text.js";

export const KIWIX_TOOLS_URL = "https://download.kiwix.org/release/kiwix-tools/";
const USER_AGENT = "arviro-setup (https://github.com/ymebosma/arviro)";
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
// One archive name, as the release folder lists them: kiwix-tools_linux-x86_64-3.7.0.tar.gz
const ARCHIVE = /kiwix-tools_([a-z]+)-([a-z0-9_]+)-(\d+(?:\.\d+){0,3})\.(tar\.gz|zip)/g;

/** The archive Kiwix publishes for this platform, or null when there is none. */
export function kiwixToolsVariant(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return { os: ["win"], arch: ["i686", "x86_64"], ext: "zip" };
  if (platform === "darwin") return { os: ["macos", "darwin"], arch: arch === "arm64" ? ["arm64", "aarch64"] : ["x86_64"], ext: "tar.gz" };
  if (platform === "linux") {
    if (arch === "x64") return { os: ["linux"], arch: ["x86_64"], ext: "tar.gz" };
    if (arch === "arm64") return { os: ["linux"], arch: ["aarch64", "arm64"], ext: "tar.gz" };
    return null;
  }
  return null;
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

/** The newest archive for the platform in the release folder's listing: { file, version }, or null. */
export function pickKiwixToolsArchive(listing, platform = process.platform, arch = process.arch) {
  const variant = kiwixToolsVariant(platform, arch);
  if (!variant) return null;
  let best = null;
  for (const match of String(listing).slice(0, MAX_LISTING_BYTES).matchAll(ARCHIVE)) {
    const [file, osName, archName, version, ext] = match;
    if (!variant.os.includes(osName) || !variant.arch.includes(archName) || ext !== variant.ext) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { file, version };
  }
  return best;
}

async function fetchOk(fetchImpl, url, { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ServiceError(`The download server could not be reached (${error.cause?.code || error.name || "error"}). Is this computer online?`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ServiceError(`The download server answered ${response.status}.`);
  }
  return response;
}

/** All files under a folder, depth first. */
function walk(folder, found = []) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

/**
 * Download kiwix-tools and put kiwix-serve in `binDir`. Returns { file, version }.
 * The archive is unpacked with the system's tar, which reads tar.gz everywhere and zip on Windows.
 */
export async function installKiwixTools({ binDir, platform = process.platform, arch = process.arch, fetchImpl = fetch, log = () => {}, listingUrl = KIWIX_TOOLS_URL } = {}) {
  const variant = kiwixToolsVariant(platform, arch);
  if (!variant) throw new ServiceError(`Kiwix publishes no kiwix-tools build for ${platform} ${arch}; install kiwix-serve by hand.`);
  log("looking up the newest kiwix-tools release");
  const listing = await (await fetchOk(fetchImpl, listingUrl, { timeoutMs: 30_000 })).text();
  const archive = pickKiwixToolsArchive(listing, platform, arch);
  if (!archive) throw new ServiceError(`No kiwix-tools archive for ${platform} ${arch} was found in the release list.`);

  const executable = platform === "win32" ? "kiwix-serve.exe" : "kiwix-serve";
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "arviro-kiwix-tools-"));
  try {
    const archivePath = path.join(workDir, archive.file);
    log(`downloading ${archive.file}`);
    const response = await fetchOk(fetchImpl, new URL(archive.file, listingUrl).href);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archivePath));

    const unpacked = path.join(workDir, "unpacked");
    fs.mkdirSync(unpacked);
    const tar = spawnSync("tar", ["-xf", archivePath, "-C", unpacked], { encoding: "utf8" });
    if (tar.error || tar.status !== 0) throw new ServiceError(`The archive could not be unpacked${tar.error ? ` (${tar.error.code || tar.error.message})` : ""}.`);
    const found = walk(unpacked).find((file) => path.basename(file) === executable);
    if (!found) throw new ServiceError(`The archive ${archive.file} does not contain ${executable}.`);

    fs.mkdirSync(binDir, { recursive: true });
    // On Windows the program comes with its libraries next to it.
    const siblings = platform === "win32" ? fs.readdirSync(path.dirname(found)).filter((name) => name.toLowerCase().endsWith(".dll")) : [];
    for (const name of [executable, ...siblings]) {
      const target = path.join(binDir, name);
      fs.copyFileSync(path.join(path.dirname(found), name), `${target}.new`);
      if (platform !== "win32") fs.chmodSync(`${target}.new`, 0o755);
      fs.renameSync(`${target}.new`, target);
    }
    const file = path.join(binDir, executable);
    log(`installed kiwix-serve ${archive.version} in ${binDir}`);
    return { file, version: archive.version };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
