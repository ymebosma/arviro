#!/usr/bin/env node
// Prepares the configuration file of an Arviro container before the server starts.
// The owner's own settings (sources, downloads, descriptions) are kept; only what the container
// needs is set each time: the listen address, the token, the hosts of the admin page, and Ollama.
import fs from "node:fs";
import path from "node:path";
import { readRawConfig, writeRawConfig } from "../../../src/configfile.js";

const dataDir = path.resolve(process.env.ARVIRO_DATA || "/data");
const configPath = path.join(dataDir, "config.json");
const externalPort = Number(process.env.ARVIRO_PORT || 11104);
const token = (process.env.ARVIRO_AUTH_TOKEN || "").trim();
const provider = (process.env.ARVIRO_EMBEDDING_PROVIDER || "").trim();
const ollamaUrl = (process.env.ARVIRO_OLLAMA_URL || "").trim().replace(/\/+$/, "");
const log = (message) => process.stderr.write(`[arviro-ods] ${message}\n`);

for (const folder of ["library/documents", "library/zim", "library/maps"]) fs.mkdirSync(path.join(dataDir, folder), { recursive: true });

const raw = readRawConfig(configPath);
const existed = Object.keys(raw).length > 0;
raw.dataDir ??= ".";
raw.sources ??= { documents: { path: "library/documents", description: "Documents added by the owner: manuals, guides and notes." } };
raw.kiwix = { ...(raw.kiwix || {}), zimDir: raw.kiwix?.zimDir || "library/zim" };

// Inside the container the server must be reachable by the other services, so it listens on every interface.
// That makes the token required: without it anyone on the Docker network could search every source.
if (!token) {
  log("ARVIRO_AUTH_TOKEN is not set; refusing to listen on 0.0.0.0 without a token");
  process.exit(1);
}
const hosts = new Set([...(raw.server?.allowedHosts || []), `127.0.0.1:${externalPort}`, `localhost:${externalPort}`, `[::1]:${externalPort}`]);
raw.server = { ...(raw.server || {}), host: "0.0.0.0", port: 8765, authToken: token, allowedHosts: [...hosts] };

if (provider) raw.embedding = { ...(raw.embedding || {}), provider };
else raw.embedding ??= { provider: "none" };
if (ollamaUrl) {
  raw.embedding = { ...(raw.embedding || {}), url: ollamaUrl };
  raw.chat = { ...(raw.chat || {}), url: ollamaUrl };
}

const config = writeRawConfig(configPath, raw);
log(`${existed ? "updated" : "created"} ${configPath}: ${Object.keys(config.sources).length} source(s), embeddings ${config.embedding.provider}, admin page on port ${externalPort}`);
