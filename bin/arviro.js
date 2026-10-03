#!/usr/bin/env node
// Command line entry point: run the MCP server, build the index, or try a search by hand.
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createArviro } from "../src/arviro.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embeddings.js";
import { createGuard } from "../src/guard.js";
import { startHttpServer } from "../src/http.js";
import { buildIndex } from "../src/indexer.js";
import { createLibrary, formatLibraryRows, formatUpdate, formatVerify } from "../src/library.js";
import { createMcpServer } from "../src/mcp.js";
import { checkEnvironment } from "../src/setup.js";
import { UserInputError } from "../src/text.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const FLAGS = new Set(["public", "full", "force", "no-index", "help", "version"]);
const USAGE = `Arviro ${VERSION}: search and read your offline library through MCP.

Usage: arviro <command> [options]

  serve                      run the MCP server over HTTP (for Open WebUI and other clients)
  stdio [--public]           run the MCP server over stdio (for clients that start it themselves)
  index [--full]             update the search index (--full rebuilds it from scratch)
  search <source> <query>    try a search   [--prefix <folder>] [--limit <n>] [--public]
  read <source> <path> [offset] [limit]     read a search result further
  status                     show sources and index contents
  doctor                     check the installation
  library status             show the ZIM files and map extracts in the library and how old they are
  library check [name...]    ask the download servers whether newer editions exist
  library update [name...]   download new or newer editions, check their checksums and update the index
                             [--force: download again] [--no-index: skip the index run]
  library verify [name...]   check the checksums of the files in the library

Options:
  --config <file>            configuration file (default: $ARVIRO_CONFIG or ~/.config/arviro/config.json)
  --public                   only public sources
`;

// Everything except protocol traffic and command output goes to stderr.
const log = (message) => process.stderr.write(`[arviro] ${message}\n`);

function parseArguments(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) { positional.push(argument); continue; }
    const key = argument.slice(2);
    if (FLAGS.has(key)) options[key] = true;
    else if (index + 1 < argv.length) options[key] = argv[index += 1];
    else throw new UserInputError(`Option --${key} needs a value.`);
  }
  return { options, positional };
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function closeOnExit(arviro, extra = async () => {}) {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await extra().catch(() => {});
    arviro.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => arviro.kiwix.stop());
  return shutdown;
}

async function serve(config) {
  const arviro = createArviro(config, { log });
  const guard = createGuard(config.guard);
  const server = await startHttpServer(arviro, { guard, version: VERSION, log });
  // The admin page can replace the application after a configuration change, so always close the current one.
  closeOnExit({ close: () => server.current().close(), kiwix: { stop: () => server.current().kiwix.stop() } }, () => server.close());
  log(`listening on ${server.url}  (all sources: /mcp, public sources: /public/mcp${config.server.admin ? `, admin page: ${server.url}/admin/` : ""})`);
  if (config.missing) log(`no configuration file at ${config.configPath} yet; open ${server.url}/admin/ to add sources`);
  if (!config.server.authToken && arviro.sources("all").some((source) => source.private)) {
    log("note: private sources are served on /mcp without a token, so every program on this computer can read them; set server.authToken to prevent that");
  }
  if (config.kiwix.books.length) arviro.kiwix.ensure().catch((error) => log(`kiwix: ${error.message}`));
}

async function stdio(config, options) {
  const arviro = createArviro(config, { log });
  const server = createMcpServer(arviro, { scope: options.public ? "public" : "all", guard: createGuard(config.guard), version: VERSION, log });
  const transport = new StdioServerTransport();
  const shutdown = closeOnExit(arviro);
  // The client ends the session by closing our input; without this the process (and kiwix-serve) would linger.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  transport.onclose = shutdown;
  await server.connect(transport);
}

async function doctor(config) {
  const arviro = createArviro(config, { log });
  let checks;
  try { checks = await checkEnvironment(config, arviro.status()); } finally { arviro.close(); }
  for (const check of checks) {
    print(`${check.ok ? "ok     " : "PROBLEM"}  ${check.label}${check.detail ? `: ${check.detail}` : ""}`);
    if (!check.ok && check.advice) print(`         ${check.advice.text}${check.advice.command ? `  ${check.advice.command}` : ""}${check.advice.url ? `  ${check.advice.url}` : ""}`);
  }
  const problems = checks.filter((check) => !check.ok).length;
  print(problems ? `\n${problems} problem(s) found.` : "\nEverything looks fine.");
  return problems ? 1 : 0;
}

/** Library management: `arviro library <status|check|update|verify> [name...]`. Returns the exit code. */
async function library(config, rest, options) {
  const [action = "status", ...names] = rest;
  const manager = createLibrary(config, { log });
  if (action === "status") { print(formatLibraryRows(manager.status())); return 0; }
  if (action === "check") {
    const rows = await manager.check(names);
    print(formatLibraryRows(rows));
    return rows.some((row) => row.verdict === "error") ? 1 : 0;
  }
  if (action === "verify") {
    const rows = await manager.verify(names);
    print(formatVerify(rows));
    return rows.some((row) => row.status === "mismatch") ? 1 : 0;
  }
  if (action === "update") {
    const summary = await manager.update(names, { force: Boolean(options.force) });
    print(formatUpdate(summary));
    if (summary.downloaded && config.library.indexAfterUpdate && !options["no-index"]) {
      log("updating the search index");
      print(await buildIndex(config, createEmbedder(config.embedding), { log }));
      if (summary.items.some((row) => row.action === "downloaded" && row.kind === "zim")) log("note: restart `arviro serve` so that it serves the new ZIM edition");
    }
    return summary.failed ? 1 : 0;
  }
  throw new UserInputError(`Unknown library command "${action}". Use: library status, check, update or verify.`);
}

async function main() {
  const { options, positional } = parseArguments(process.argv.slice(2));
  const [command, ...rest] = positional;
  if (options.version) return print(VERSION);
  if (!command || options.help || command === "help") return print(USAGE);

  // The server starts without a configuration file, so that the admin page can create one.
  const config = loadConfig(options.config, { allowMissing: command === "serve" });
  const scope = options.public ? "public" : "all";
  if (command === "serve") return serve(config);
  if (command === "stdio") return stdio(config, options);
  if (command === "doctor") { process.exitCode = await doctor(config); return; }
  if (command === "library") { process.exitCode = await library(config, rest, options); return; }
  if (command === "index") {
    const summary = await buildIndex(config, createEmbedder(config.embedding), { log, full: Boolean(options.full) });
    return print(summary);
  }

  const arviro = createArviro(config, { log });
  try {
    if (command === "status") print(arviro.status());
    else if (command === "search") {
      const [source, ...words] = rest;
      if (!source || !words.length) throw new UserInputError("Usage: arviro search <source> <query> [--prefix <folder>] [--limit <n>]");
      print(await arviro.search({ source, query: words.join(" "), pathPrefix: options.prefix || "", limit: options.limit }, scope));
    } else if (command === "read") {
      const [source, path, offset, limit] = rest;
      if (!source || !path) throw new UserInputError("Usage: arviro read <source> <path> [offset] [limit]");
      print((await arviro.read({ source, path, offset, limit }, scope)).text);
    } else {
      throw new UserInputError(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } finally {
    arviro.close();
  }
}

main().catch((error) => {
  if (error instanceof ConfigError || error instanceof UserInputError) process.stderr.write(`${error.message}\n`);
  else process.stderr.write(`${error.stack || error}\n`);
  process.exit(error instanceof ConfigError || error instanceof UserInputError ? 2 : 1);
});
