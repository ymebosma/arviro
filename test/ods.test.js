import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

const folder = fileURLToPath(new URL("../deploy/ods/arviro/", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "arviro-ods-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const prepare = (dataDir, env) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(folder, "prepare-config.mjs")], { env: { PATH: process.env.PATH, ARVIRO_DATA: dataDir, ...env } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
});

test("the ODS extension folder has what ODS's library expects", () => {
  for (const name of ["manifest.yaml", "compose.yaml", "Dockerfile", "README.md", "upstream.json", "entrypoint.sh", "prepare-config.mjs"]) assert.ok(fs.existsSync(path.join(folder, name)), name);
  const manifest = fs.readFileSync(path.join(folder, "manifest.yaml"), "utf8");
  assert.match(manifest, /^schema_version: ods\.services\.v1$/m);
  assert.match(manifest, /^  id: arviro$/m);
  assert.match(manifest, /^  port: 8765$/m);
  assert.match(manifest, /^  health: \/health$/m);
  assert.match(manifest, /key: ARVIRO_AUTH_TOKEN\n\s+required: true\n\s+secret: true/);
  const compose = fs.readFileSync(path.join(folder, "compose.yaml"), "utf8");
  assert.match(compose, /127\.0\.0\.1:\$\{ARVIRO_PORT:-11104\}:8765/);
  assert.match(compose, /ARVIRO_AUTH_TOKEN: \$\{ARVIRO_AUTH_TOKEN:\?/);
  assert.match(compose, /- \.\/data\/arviro:\/data/);
  assert.match(compose, /ods-network/);
  const dockerfile = fs.readFileSync(path.join(folder, "Dockerfile"), "utf8");
  assert.match(dockerfile, /kiwix-serve/);
  assert.match(dockerfile, /osmium-tool poppler-utils/);
  assert.match(dockerfile, /ENTRYPOINT \["\/opt\/arviro\/deploy\/ods\/arviro\/entrypoint\.sh"\]/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "upstream.json"), "utf8")).license, "MIT");
});

test("prepare-config creates a container configuration and keeps the owner's settings", async () => {
  const dataDir = path.join(root, "data");
  const first = await prepare(dataDir, { ARVIRO_AUTH_TOKEN: "t".repeat(40), ARVIRO_PORT: "11104", ARVIRO_OLLAMA_URL: "http://ollama:11434/" });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /created .*config\.json: 1 source\(s\), embeddings none, admin page on port 11104/);
  for (const name of ["library/documents", "library/zim", "library/maps"]) assert.ok(fs.statSync(path.join(dataDir, name)).isDirectory(), name);

  const config = loadConfig(path.join(dataDir, "config.json"));
  assert.equal(config.dataDir, dataDir);
  assert.equal(config.sources.documents.root, path.join(dataDir, "library/documents"));
  assert.equal(config.kiwix.zimDir, path.join(dataDir, "library/zim"));
  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.server.port, 8765);
  assert.equal(config.server.authToken, "t".repeat(40));
  assert.deepEqual(config.server.allowedHosts, ["127.0.0.1:11104", "localhost:11104", "[::1]:11104"]);
  assert.equal(config.embedding.provider, "none");
  assert.equal(config.embedding.url, "http://ollama:11434");
  assert.equal(config.chat.url, "http://ollama:11434");

  // The owner changed sources and downloads on the admin page; a restart keeps them and applies the new token and port.
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  raw.sources.notes = { path: "library/notes", description: "Notes", private: true };
  raw.library = { downloads: [{ zim: "wikipedia_nl_all_nopic" }] };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(raw, null, 2));
  const second = await prepare(dataDir, { ARVIRO_AUTH_TOKEN: "u".repeat(40), ARVIRO_PORT: "12000", ARVIRO_EMBEDDING_PROVIDER: "ollama", ARVIRO_OLLAMA_URL: "http://ollama:11434" });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, /updated .*: 2 source\(s\), embeddings ollama, admin page on port 12000/);
  const updated = loadConfig(path.join(dataDir, "config.json"));
  assert.equal(updated.sources.notes.private, true);
  assert.deepEqual(updated.library.downloads.map((item) => item.id), ["wikipedia_nl_all_nopic"]);
  assert.equal(updated.server.authToken, "u".repeat(40));
  assert.ok(updated.server.allowedHosts.includes("127.0.0.1:12000"));
  assert.ok(updated.server.allowedHosts.includes("127.0.0.1:11104"), "earlier hosts are kept");
  assert.equal(updated.embedding.provider, "ollama");

  const refused = await prepare(path.join(root, "other"), {});
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /ARVIRO_AUTH_TOKEN is not set/);
  assert.ok(!fs.existsSync(path.join(root, "other", "config.json")));
});
