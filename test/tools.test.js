import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { ServiceError } from "../src/text.js";
import { installKiwixTools, kiwixToolsVariant, pickKiwixToolsArchive } from "../src/tools.js";
import { startFakeKiwixTools } from "./helpers.js";

const remote = startFakeKiwixTools();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "arviro-tools-test-"));
before(() => remote.start());
after(async () => {
  await remote.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the newest kiwix-tools archive for the platform is picked from the release listing", () => {
  assert.deepEqual(pickKiwixToolsArchive(remote.listing, "linux", "x64"), { file: "kiwix-tools_linux-x86_64-3.10.0.tar.gz", version: "3.10.0" });
  assert.equal(pickKiwixToolsArchive(remote.listing, "linux", "arm64").file, "kiwix-tools_linux-aarch64-3.10.0.tar.gz");
  assert.equal(pickKiwixToolsArchive(remote.listing, "darwin", "arm64").file, "kiwix-tools_macos-arm64-3.10.0.tar.gz");
  assert.equal(pickKiwixToolsArchive(remote.listing, "darwin", "x64").file, "kiwix-tools_macos-x86_64-3.10.0.tar.gz");
  assert.equal(pickKiwixToolsArchive(remote.listing, "win32", "x64").file, "kiwix-tools_win-i686-3.10.0.zip");
  // 32-bit ARM Linux and other platforms have no build here.
  assert.equal(kiwixToolsVariant("linux", "arm"), null);
  assert.equal(pickKiwixToolsArchive(remote.listing, "freebsd", "x64"), null);
  assert.equal(pickKiwixToolsArchive("<html>nothing</html>", "linux", "x64"), null);
});

test("installKiwixTools downloads the archive and puts an executable kiwix-serve in the bin folder", async () => {
  const binDir = path.join(root, "bin");
  const lines = [];
  const result = await installKiwixTools({ binDir, platform: "linux", arch: "x64", listingUrl: remote.url, log: (line) => lines.push(line) });
  assert.equal(result.version, "3.10.0");
  assert.equal(result.file, path.join(binDir, "kiwix-serve"));
  assert.equal(fs.statSync(result.file).mode & 0o111, 0o111);
  assert.equal(spawnSync(result.file, { encoding: "utf8" }).stdout.trim(), "kiwix-serve fake 3.10.0");
  assert.equal(fs.existsSync(path.join(binDir, "kiwix-manage")), false, "only kiwix-serve is installed");
  assert.ok(lines.some((line) => line.includes("downloading kiwix-tools_linux-x86_64-3.10.0.tar.gz")), lines.join("\n"));
  assert.ok(remote.requests.includes("/release/kiwix-tools/kiwix-tools_linux-x86_64-3.10.0.tar.gz"));
  // No temporary files are left behind next to the program.
  assert.deepEqual(fs.readdirSync(binDir), ["kiwix-serve"]);
});

test("installKiwixTools explains in safe words when something is wrong", async () => {
  const binDir = path.join(root, "bin2");
  await assert.rejects(installKiwixTools({ binDir, platform: "linux", arch: "arm", listingUrl: remote.url }), (error) => error instanceof ServiceError && /no kiwix-tools build/.test(error.message));
  await assert.rejects(installKiwixTools({ binDir, platform: "linux", arch: "x64", listingUrl: `${remote.url}missing/` }), (error) => error instanceof ServiceError && /answered 404/.test(error.message));
  await assert.rejects(installKiwixTools({ binDir, platform: "linux", arch: "x64", listingUrl: "http://127.0.0.1:1/" }), (error) => error instanceof ServiceError && /could not be reached/.test(error.message));
  remote.serveEmpty = true;
  try {
    await assert.rejects(installKiwixTools({ binDir, platform: "linux", arch: "x64", listingUrl: remote.url }), (error) => error instanceof ServiceError && /does not contain kiwix-serve/.test(error.message));
  } finally {
    remote.serveEmpty = false;
  }
  assert.equal(fs.existsSync(binDir), false, "nothing is written when the install fails");
});
