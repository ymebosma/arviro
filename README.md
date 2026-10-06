# Arviro

Arviro is a small [MCP](https://modelcontextprotocol.io) server that lets a local language model search and read your own offline library:

- **documents** in folders on disk (PDF, Markdown, text, HTML, CSV, JSON);
- **Kiwix ZIM files** such as an offline Wikipedia or Wikivoyage;
- **OpenStreetMap extracts**, for questions about places and what is near them.

Everything runs on your own computer. Arviro only reads; it cannot change your files, and the server does not use the internet. The only exception is `arviro library update`, a command for you that downloads new editions of ZIM files and map extracts.

It is made for chat apps that speak MCP, such as [Open WebUI](https://openwebui.com) with a model served by [Ollama](https://ollama.com). It also has a chat page of its own, so that Ollama and Arviro are all you need.

## What the model gets

Two tools:

| Tool | What it does |
| --- | --- |
| `search_library` | Searches one source and returns the best passages, each with ready-made arguments for reading on. |
| `read_document` | Returns part of a document (by page for a PDF, by line otherwise) or of an encyclopedia article. |

Some things are built in because small local models need them:

- **One source per search.** The model chooses a source; the tool description lists your sources with your own descriptions.
- **Search by meaning and by words.** Passages are found with SQLite full-text search and, when Ollama is available, with embeddings. A Dutch question finds an English manual.
- **An evidence check for "who is X?" questions.** A name only counts as confirmed when a source has exactly that title. An unknown name gives "not found", and a misspelled name in an encyclopedia gives "did you mean…", so the model has no reason to make something up.
- **Bounded answers.** Results are short, long documents are read in parts, and each part says how to continue.
- **Protection against loops.** A repeated identical call gets the earlier result back with a note to stop, and there is a call budget per minute.
- **Private and public sources.** Sources marked `private` are only served on `/mcp`; `/public/mcp` leaves them out. This lets you give housemates the library without your personal notes; see [Security](#security) for what that takes.

## Requirements

- Node.js 22.13 or newer.
- Optional, depending on what you want to search:
  - [Ollama](https://ollama.com) with an embedding model, for search by meaning (`ollama pull qwen3-embedding:0.6b`);
  - `pdftotext` from poppler, for PDF files;
  - `kiwix-serve` from [kiwix-tools](https://github.com/kiwix/kiwix-tools), for ZIM files;
  - `osmium` from [osmium-tool](https://osmcode.org/osmium-tool/), for map data.

On macOS with Homebrew: `brew install node poppler osmium-tool`. Download kiwix-tools from [kiwix.org](https://kiwix.org/en/applications/) and put `kiwix-serve` in your PATH or in `~/.local/bin`.

## Install

```bash
git clone https://github.com/ymebosma/arviro.git
cd arviro
npm install
```

Then start the server and open its admin page:

```bash
node bin/arviro.js serve      # starts the server on http://127.0.0.1:8765
```

Open <http://127.0.0.1:8765/admin/> in a browser. The page shows what is installed and what is missing (with the command to install it, and a button where the page can do it itself), lets you add document folders, choose encyclopedias and maps from the catalogues, download them, and build the search index. It writes `~/.config/arviro/config.json` for you; see [The admin page](#the-admin-page).

The same can be done by hand: copy `arviro.config.example.json` to `~/.config/arviro/config.json`, edit it so that it points at your own folders (see [Configuration](#configuration)), and run:

```bash
node bin/arviro.js doctor     # checks the configuration and the helper programs
node bin/arviro.js index      # builds the search index; run it again after adding documents
```

`node bin/arviro.js library update` downloads the ZIM files and map extracts listed in the configuration; see [Keeping the library up to date](#keeping-the-library-up-to-date).

`npm link` makes the `arviro` command available everywhere, so you can type `arviro serve`.

Try a search without any chat app:

```bash
node bin/arviro.js search library "how do I make water safe to drink?"
node bin/arviro.js read library manuals/water.md
```

## The admin page

`arviro serve` also serves a page for you, the owner, at `/admin/`. It is only reachable from the computer itself, unless `server.authToken` is set; then the page asks for that token. Set `server.admin` to `false` to switch it off.

- **Environment**: the checks of `arviro doctor`, with the command to install what is missing on your platform. The page itself can pull the embedding model through Ollama and build the index.
- **Library**: your document folders (with a folder browser), the download list with what is on disk and how old it is, buttons to check for updates and to update, and a search in the Kiwix catalogue and Geofabrik's region list to add encyclopedias and maps. A few common choices are shown before you search.
- **Chat**: a conversation with a model from Ollama that uses the library, so Arviro works without any other chat app. The model gets the same two tools and the same system prompt (`examples/system-prompt.en.md`) a chat app would; each search and read is shown in the conversation, with its result. Choose a model that can call tools, such as `qwen3` or `llama3.1`.
- **Connect**: the URLs and tokens a chat app needs, and the steps for Open WebUI.

Changes are written to the configuration file (relative to `~` where possible) and take effect at once; only `server.*` settings need a restart. Jobs such as an index build run one at a time in the server, with their log on the page. The MCP endpoints do not change: `/admin/` is not a tool, and the model cannot reach it.

## Use with Open WebUI

Open WebUI (0.6.31 or newer) connects to MCP servers over Streamable HTTP, which is what `arviro serve` offers.

1. Start Arviro: `arviro serve`.
2. In Open WebUI, as admin, open **Settings** and choose **Integrations** in the admin part. At **External Tool Servers** press **+** and fill in:
   - Type: **MCP (Streamable HTTP)**
   - URL: `http://127.0.0.1:8765/mcp`, or `http://127.0.0.1:8765/public/mcp` for the sources without your private ones
   - Auth: **None**, or **Bearer** with the token when you have set one
   - ID: `arviro`

   With **Access Control** you decide which users may use the connection. To give yourself all sources and others only the public ones, add two connections with different IDs.
3. In a chat, switch the tool on with the integrations button under the message box. To have it on by default, create a model under **Workspace → Models**: choose your Ollama model as base, paste a system prompt (see [`examples/`](examples/)), and tick the Arviro tool server. Leave function calling on **Native**.

Open WebUI puts the connection ID in front of the tool names, so with the ID `arviro` the model sees `arviro_search_library` and `arviro_read_document`. It calls its MCP support experimental; this setup was tested with Open WebUI 0.11.4.

Two things that matter for local models:

- Give the model enough context. Tool results are a few thousand tokens each; a context of 16k tokens or more works well.
- Open WebUI adds its own built-in tools in native mode. For a strictly offline assistant, switch those off for the model (Capabilities → Builtin Tools).

If Open WebUI runs in Docker, `127.0.0.1` is the container itself. Set `server.host` to `0.0.0.0`, add `host.docker.internal:8765` to `server.allowedHosts`, set `server.authToken` and `server.publicToken`, and use `http://host.docker.internal:8765/mcp` with Auth **Bearer**.

## Use with other MCP clients

Clients that start MCP servers themselves can use the stdio transport:

```json
{
  "mcpServers": {
    "arviro": {
      "command": "node",
      "args": ["/path/to/arviro/bin/arviro.js", "stdio"]
    }
  }
}
```

Add `"--public"` to the arguments to leave out private sources.

## Configuration

The configuration is one JSON file: `~/.config/arviro/config.json`, or the file named by `--config` or `$ARVIRO_CONFIG`. Paths may start with `~`; relative paths are relative to the configuration file.

```json
{
  "dataDir": "~/.local/share/arviro",
  "sources": {
    "library": {
      "path": "~/Library/Offline",
      "description": "Offline reference library: emergency plans, first aid, survival guides and technical manuals.",
      "expandQueries": true,
      "routes": [{ "prefix": "medical", "terms": ["first aid", "medical"] }]
    },
    "notes": { "path": "~/Notes", "description": "Personal notes.", "private": true }
  },
  "kiwix": { "zimDir": "~/Library/Offline/zim" },
  "maps": { "regions": { "nl": "~/Library/Offline/maps/netherlands-latest.osm.pbf" } }
}
```

| Setting | Meaning |
| --- | --- |
| `dataDir` | Where the search index is kept. Default `~/.local/share/arviro`. |
| `sources.<id>.path` | A folder with documents. The id is what the model uses to choose the source. |
| `sources.<id>.description` | One sentence telling the model what is in the source. Worth writing well. |
| `sources.<id>.private` | `true` hides the source from `/public/mcp` and `arviro stdio --public`. |
| `sources.<id>.expandQueries` | `true` adds cross-language terms to a question (see `search.queryExpansions`). |
| `sources.<id>.routes` | Narrows a search to a folder when the question contains one of the terms. If that finds nothing, the whole source is searched. |
| `sources.<id>.exclude` | Extra folder or file names to leave out. `.git`, `node_modules`, `zim`, `pmtiles` and `vendor` are always left out, as is anything starting with a dot. What is left out is neither indexed nor readable. |
| `kiwix.zimDir` | A folder with `.zim` files. Each file becomes a source named after the first part of its file name: `wikipedia_nl_all_nopic_2026-04.zim` becomes `wikipedia`. Of several editions, the newest is used. |
| `kiwix.descriptions` | Descriptions per ZIM source, for example `{ "wikipedia": "Dutch Wikipedia" }`. |
| `kiwix.port` | Port for the kiwix-serve process that Arviro starts on 127.0.0.1. Default 8767. |
| `kiwix.private` | List of ZIM source ids to treat as private, for example `["wikipedia"]`. |
| `maps.regions` | OpenStreetMap extracts (`.osm.pbf`) by region name. Together they form the source `maps`. |
| `maps.description`, `maps.private` | Description of the map source for the model, and `true` to make it private. |
| `library.downloads` | What `arviro library update` keeps up to date: `{ "zim": "<name>" }` for a book from the Kiwix catalogue, `{ "map": "<region>", "url": "<extract>" }` for a region of `maps.regions`. See [Keeping the library up to date](#keeping-the-library-up-to-date). |
| `library.indexAfterUpdate` | Run the index after a download. Default `true`. |
| `library.keepOldEditions` | Keep earlier editions of a ZIM file after a newer one is downloaded. Default `false`: they are deleted. |
| `library.kiwixCatalog` | The Kiwix catalogue to ask for the latest editions. Default `https://library.kiwix.org/catalog/v2`. |
| `library.geofabrikIndex` | Geofabrik's region list, used by the admin page. Default `https://download.geofabrik.de/index-v1-nogeom.json`. |
| `embedding.provider` | `ollama` (default) or `none` for full-text search only. |
| `embedding.url`, `.model`, `.dimensions` | Default `http://127.0.0.1:11434`, `qwen3-embedding:0.6b`, 512. After changing the model or the dimensions, run `arviro index`: it rebuilds the index. Until then, search uses words only and says so. |
| `server.host`, `.port` | Default `127.0.0.1` and 8765. |
| `server.authToken` | Bearer token for `/mcp`, the endpoint with all sources. |
| `server.publicToken` | Bearer token for `/public/mcp`. The token of `/mcp` is accepted here too. |
| `server.allowedHosts`, `.allowedOrigins` | Extra `Host` and `Origin` header values to accept. |
| `server.admin` | `false` switches the admin page at `/admin/` off. Default `true`. |
| `search.minSemanticScore` | How similar a passage must be when none of the question's words occur in it. Default 0.76, tuned for `qwen3-embedding`. |
| `search.queryExpansions` | List of `[pattern, terms]`: when the pattern matches the question, the terms are added. The default list maps common Dutch emergency and medical words to English. |
| `read.maxChars` | Size of one part returned by `read_document`. Default 12000 characters. |
| `chat.model` | The model for the Chat tab; by default the first chat model Ollama has. |
| `chat.url` | Ollama for the chat, when it is not the one of `embedding.url`. |
| `chat.systemPrompt` | A file with the system prompt. Default `examples/system-prompt.en.md`; `examples/system-prompt.nl.md` is the Dutch one. |
| `chat.numCtx`, `.maxRounds` | Context size for the chat (default 16384) and how often the model may call tools in one turn (default 6). |
| `chat.numPredict`, `.timeoutSeconds` | How many tokens the model may generate per answer, thinking included (default 8192), and how long one answer may take (default 600 seconds). A model that keeps thinking blocks every other Ollama request, so a limit matters. |
| `chat.think` | `false` switches thinking off for models that can think (`qwen3` and the like); `true` switches it on. Unset leaves it to the model; its thinking is shown dimmed in the chat. With the library tools, thinking off is often the better setting: answers come faster, and a model that loops in its thinking runs out of room before it answers. |
| `guard.windowMs`, `.maxCallsPerWindow`, `.maxCallsTotal` | Loop protection: at most 20 calls per 60 seconds for one connection, and 120 for all connections together. |
| `tools.pdftotext`, `.kiwixServe`, `.osmium` | Paths of the helper programs, when they are not found automatically. |

### Documents

Arviro indexes `.md`, `.txt`, `.html`, `.csv`, `.tsv` and `.json` files up to 8 MB, and `.pdf` files up to 64 MB.

A PDF can have a text copy that is used in its place, for indexing and for reading. That is useful for a scanned PDF, or when you have a better text version than `pdftotext` gives. The copy is `report.txt` next to `report.pdf`, or in a sibling folder named `text` (or `tekst`) when the PDF is in `documents` (or `documenten`). Results still point at the PDF and its page numbers, provided the copy has a form feed between pages, as `pdftotext` writes it.

When the folder of one source lies inside the folder of another, its documents belong to the inner source only. A private folder inside a public one therefore stays private.

### Updating

Run `arviro index` after adding or changing documents. It only processes what changed, and a running server picks up the new index by itself. `arviro index --full` rebuilds everything.

If a source folder cannot be read during a run, for example because a disk is not connected, its documents stay in the index.

### Keeping the library up to date

`arviro library` downloads ZIM files and map extracts, checks their checksums and tells you what is in the library and how old it is. It only touches what is listed under `library.downloads` in the configuration; this is the only part of Arviro that writes to the library, and it is a command for you, not a tool for the model.

```json
"library": {
  "downloads": [
    { "zim": "wikipedia_nl_all_nopic" },
    { "zim": "wikivoyage_nl_all_maxi" },
    { "map": "nl", "url": "https://download.geofabrik.de/europe/netherlands-latest.osm.pbf" }
  ]
}
```

- A `zim` entry is the name of a book as the [Kiwix library](https://library.kiwix.org) lists it, without the edition date. Its latest edition is looked up in the Kiwix catalogue and saved in `kiwix.zimDir`; the SHA-256 checksum from the download's metalink file is checked. Earlier editions of the same book are deleted afterwards, unless `library.keepOldEditions` is `true`.
- A `map` entry names a region of `maps.regions` and the URL of its extract, for example from [Geofabrik](https://download.geofabrik.de). The file is saved at the region's path. The checksum is read from `<url>.md5`, as Geofabrik publishes it; set `"checksum"` to another URL (`.md5`, `.sha1` or `.sha256`) for other servers, or to `false` to download without a check.

The commands:

```bash
arviro library status             # what is there, how big it is, how old it is, and when it was last verified
arviro library check              # asks the servers whether newer editions exist; downloads nothing
arviro library update             # downloads what is missing or newer, checks the checksums, then runs the index
arviro library update nl --force  # downloads one item again, even when it is up to date
arviro library verify             # recomputes the checksums of the files on disk
```

`status` also lists ZIM files and map regions that are not in `library.downloads`, so you see everything that is there. A download goes to a `.part` file next to its destination and is only put in place when it is complete and its checksum matches; an interrupted download continues where it stopped the next time. What was downloaded, with its checksum, is kept in `library.json` in `dataDir`.

After a download, `update` runs `arviro index` (switch that off with `--no-index` or `library.indexAfterUpdate`). A running `arviro serve` picks up the new index by itself, but it lists ZIM files when it starts: restart it after a new ZIM edition has arrived.

To run the update on a schedule, use [`examples/launchd.library.plist`](examples/launchd.library.plist) on macOS (weekly, Sunday at 04:00) or a cron line on Linux:

```
0 4 * * 0  /usr/bin/node /path/to/arviro/bin/arviro.js library update >> ~/.local/share/arviro/library.log 2>&1
```

## Run it inside ODS

[ODS](https://github.com/Osmantic/ODS) installs a local AI stack on Docker, with Open WebUI and a catalogue of extensions. [`deploy/ods/arviro/`](deploy/ods/arviro/) makes Arviro such an extension: one container with Arviro, kiwix-serve, osmium and pdftotext, the admin page on port 11104 of the host, and the MCP endpoint at `http://arviro:8765/mcp` for ODS's Open WebUI. Its README has the steps.

## Run it as a service on macOS

[`examples/launchd.plist`](examples/launchd.plist) is a LaunchAgent that starts Arviro at login and restarts it when it stops. Replace the paths in it, copy it to `~/Library/LaunchAgents/local.arviro.plist` and load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.arviro.plist
```

## Security

- **Read-only.** `read_document` only returns documents that a source offers. Paths are resolved first, so a symbolic link cannot lead outside the source or into a hidden or excluded folder.
- **Local by default.** The server listens on 127.0.0.1. Requests that carry a web page's `Origin` header or an unknown `Host` header are refused, so a website in your browser cannot query it. The admin page is the one page the server serves itself; its own origin is accepted, and it is only served to connections from the computer itself (or with the token of `/mcp`).
- **The admin page changes the configuration.** Anyone who can open it can add folders to the library and start downloads. On a shared computer, set `server.authToken`; then the page needs that token too.
- **No login by default.** Without tokens, every program and every user on the computer can call both endpoints. Private sources are then kept from the public endpoint, but not from someone who calls `/mcp` directly. Set `server.authToken` when that matters, and always when the host is not 127.0.0.1.
- **Private and public.** To share only the public sources with other people, give their chat app the `/public/mcp` URL and keep the token of `/mcp` to yourself. In Open WebUI that means two connections, each with its own access control.
- **Documents are untrusted input.** The tool descriptions tell the model so, but a model can still be misled by text in a document. Do not connect Arviro to a model that can also take actions you would not want a document to trigger.
- **Error messages** to the model never contain file paths; details go to the server's log.

## Development

```bash
npm test
```

The tests build a small library in a temporary folder and use stand-ins for Ollama, kiwix-serve, osmium and pdftotext, so none of those need to be installed.

Layout: `bin/arviro.js` is the command line; `src/arviro.js` ties the sources together; `src/documents.js`, `src/kiwix.js` and `src/osm.js` search; `src/reader.js` reads files; `src/indexer.js` builds the index; `src/library.js` downloads and checks library content; `src/mcp.js` and `src/http.js` expose it over MCP; `src/admin.js`, `src/setup.js`, `src/catalogue.js`, `src/configfile.js`, `src/chat.js` and `src/ui/` are the admin page.

## Not there yet

- Map search only knows places and amenities that OpenStreetMap stores as a point. A hospital or shop drawn as a building outline is not found yet.
- Packaged installers for macOS, Windows and Linux, and a client for phones.
- Pages to view articles and maps in a browser, so answers can link to them.
- A tool for the assistant's own notes and tasks.

## License

MIT; see [LICENSE](LICENSE).
