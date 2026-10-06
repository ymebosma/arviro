# Arviro

An MCP server that lets a local language model search and read an offline library: document folders, Kiwix ZIM books and OpenStreetMap extracts. README.md describes what it does and how it is configured; this file is for working on the code.

## Commands

- `npm test` runs all tests (`node --test`). Run it before every commit.
- `node bin/arviro.js --help` lists the commands (`serve`, `stdio`, `index`, `search`, `read`, `status`, `doctor`, `library`).

The tests are self-contained: they build a small library in a temporary folder and use stand-ins for Ollama, kiwix-serve, osmium and pdftotext (see `test/helpers.js`), and a stand-in for the Kiwix catalogue and the download servers (`test/library.test.js`). Nothing needs to be installed besides Node.js and the npm dependencies, and no test uses the network.

## Layout

- `bin/arviro.js`: command line.
- `src/arviro.js`: the application; `search` and `read` across sources, with a scope (`all` or `public`).
- `src/config.js`: loads and validates the configuration; derives the sources.
- `src/documents.js`: hybrid search (SQLite FTS5 and embeddings) over indexed documents.
- `src/indexer.js`, `src/db.js`, `src/embeddings.js`, `src/copies.js`: building the index.
- `src/library.js`: the `library` command for the owner; downloads ZIM files and map extracts from `library.downloads`, checks checksums, keeps `library.json` in `dataDir`. Not reachable by the model.
- `src/kiwix.js`: ZIM books through a kiwix-serve child process.
- `src/osm.js`: map data, indexing and search.
- `src/reader.js`: bounded reading of files inside a source.
- `src/evidence.js`: the verdict for "who is X?" questions.
- `src/guard.js`: protection against repeated tool calls.
- `src/mcp.js`, `src/http.js`: the MCP tools, over stdio and stateless Streamable HTTP. `http.js` also serves the admin page and can swap in a new application after a configuration change.
- `src/admin.js`: the admin page's JSON API and jobs (index, library update, model pull); `src/setup.js`: environment checks with platform advice (also `doctor`); `src/catalogue.js`: curated entries, Kiwix catalogue search, Geofabrik regions; `src/configfile.js`: editing the owner's config file; `src/chat.js`: the Chat tab, Ollama's `/api/chat` with the MCP tools through an in-memory client; `src/ui/`: the page (plain HTML, CSS and JS; nothing external, because the library is offline).
- `src/text.js`: text helpers and the two error classes.
- `deploy/ods/arviro/`: Arviro as an ODS (Osmantic Deployment System) extension: Dockerfile, ODS manifest and compose file, and the script that prepares the container's configuration. The manifest follows ODS's `service-manifest.v1.json`; validate it against a checkout of ODS when it changes.

## Rules

- Plain ESM JavaScript for Node.js 22.13 or newer, without a build step. The only runtime dependencies are `@modelcontextprotocol/sdk` and `zod`; add one only with a good reason.
- Arviro is read-only. Do not add a tool that changes files in a source. The `library` command and the admin page are the exception: they write ZIM files, map extracts and the configuration file for the owner, never through MCP.
- The admin page is served to loopback connections only (or with `server.authToken`), accepts its own origin and no other, and its API takes JSON only. Keep it that way: it changes the configuration and starts downloads. Document content reaches the page only through the Chat tab, which uses the MCP tools in the `all` scope like any chat app of the owner.
- Every path that comes from a caller goes through `resolveInside` in `src/reader.js`. What the index leaves out (hidden, excluded, nested sources) must not be readable either.
- Every function that returns content takes a scope. When you add a feature, add a test that the `public` scope does not show private sources.
- Code that runs on document content must be linear in the size of the input: no regular expression that can backtrack over an unbounded part of the text. `test/text.test.js` has timing tests for this; extend them when you add a pattern.
- Messages for the model are either a `UserInputError` (the caller's mistake, with advice) or a `ServiceError` (a problem on the server side, in safe words). Any other error is logged and replaced by a generic message. Never put file paths in a message for the model.
- The tool names, descriptions and result texts are the interface for small local models. Keep them short and change them only for a reason; a test with a real model runs on the owner's machine, not here.
- When the index schema changes, raise `INDEX_VERSION` in `src/db.js`. When passages or embedding inputs change in a way that needs new embeddings, change `EMBEDDING_PROFILE`.
- Keep README.md in step with the defaults in `src/config.js`.
- No personal data in the repository: no real names, home folders, addresses or tokens. Examples use neutral names and places.

## Not in this repository

The library content, the search index and the owner's configuration live on the owner's computer. Checks against real data, Ollama, Kiwix and Open WebUI are done there.

## Open work

- Map search only knows OpenStreetMap nodes. Amenities drawn as building outlines (ways) are missing; indexing them needs their centre point.
- A line longer than 1600 characters is cut when read, and the rest of that line cannot be reached.
- The chat has been tried with one thinking model (Qwen 3.6 through Ollama). Other models may stream differently; `src/chat.js` reads `message.thinking`, `message.content` and `message.tool_calls`.
- Pages to view articles and maps in a browser, so answers can link to them.
- A tool for the assistant's own notes and tasks.
- Titles of "did you mean" suggestions exist for Kiwix sources only.
