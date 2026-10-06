# Arviro as an ODS extension

[ODS](https://github.com/Osmantic/ODS) (Osmantic Deployment System) installs a local AI stack on Docker: a model server, Open WebUI, a dashboard and a catalogue of extensions. This folder makes Arviro one of those extensions, so that the model in ODS can search and read an offline library through MCP.

What you get:

- a container `ods-arviro` with Arviro, kiwix-serve, osmium and pdftotext;
- the MCP endpoint at `http://arviro:8765/mcp` inside the stack, for Open WebUI;
- the admin page at <http://127.0.0.1:11104/admin/> on the host, where you add document folders, download ZIM files and map extracts with checksum verification, build the index and chat with the library;
- the library and the index under `data/arviro/` of your ODS installation, so they survive image rebuilds.

## Install

1. Copy this folder into your ODS checkout as `ods/extensions/library/services/arviro/` (or `ods/extensions/services/arviro/`).
2. Enable it. ODS generates the token (`ARVIRO_AUTH_TOKEN`) and builds the image from the Arviro source on GitHub:

   ```bash
   ods enable arviro
   ods start arviro
   ods logs arviro
   ```

   Set `ARVIRO_REF` in `.env` to build another branch, tag or commit than `main`.
3. Open <http://127.0.0.1:11104/admin/>. The page asks for the token; it is in `.env` (`ods config show` masks it, so read the file). Add a document folder under `data/arviro/library/documents`, choose encyclopedias and maps from the catalogues, and press **Update now**; the index builds by itself.

The container listens on every interface inside the Docker network, so the token is required: without `ARVIRO_AUTH_TOKEN` it refuses to start.

## Connect Open WebUI

In Open WebUI (port 3000 in ODS), as admin: **Settings → Integrations → External Tool Servers → +**, type **MCP (Streamable HTTP)**, URL `http://arviro:8765/mcp`, Auth **Bearer** with the token, ID `arviro`. Then switch the tool on in a chat, or tick it in a model under **Workspace → Models**. The model sees `arviro_search_library` and `arviro_read_document`.

For sources without your private ones, use `http://arviro:8765/public/mcp`; it accepts the same token.

## Search by meaning and the chat tab

Arviro uses Ollama for embeddings and for its own chat tab. ODS serves its main model with llama-server, which Arviro does not speak yet, so:

1. Enable the `ollama` extension in ODS (Linux with NVIDIA or AMD).
2. Pull the models inside it:

   ```bash
   docker exec ods-ollama ollama pull qwen3-embedding:0.6b
   docker exec ods-ollama ollama pull qwen3:8b
   ```

3. Set `ARVIRO_EMBEDDING_PROVIDER=ollama` in `.env` and restart Arviro (`ods restart arviro`). `ARVIRO_OLLAMA_URL` is `http://ollama:11434` by default.
4. On the admin page, **Environment** shows whether Ollama and the embedding model are reachable, and the index can be rebuilt from there. The **Chat** tab lists the chat models of that Ollama.

Without Ollama, search works by words only and the chat tab says that it needs Ollama. Open WebUI with its own model still works through MCP.

## Files

| File | Purpose |
| --- | --- |
| `manifest.yaml` | Service contract for ODS: port 8765, health `/health`, the token and the Ollama settings. |
| `compose.yaml` | The container: image built from source, port 11104 on the host, `data/arviro` mounted at `/data`, read-only root filesystem. |
| `Dockerfile` | Node.js 22 on Debian, osmium-tool and poppler-utils from Debian, kiwix-serve copied from the official Kiwix image, Arviro cloned at `ARVIRO_REF`. |
| `entrypoint.sh`, `prepare-config.mjs` | Prepare `/data/config.json` from the environment on every start, keeping the owner's own settings, then run `arviro serve`. |
| `upstream.json` | Provenance as ODS's library expects it. |

## Limits

- Not yet run inside a real ODS installation; the manifest and compose file follow ODS's schema and its library recipes, and the configuration script is covered by Arviro's tests.
- Arviro's embeddings and chat need Ollama; a provider for OpenAI-compatible servers such as llama-server and LiteLLM is a next step.
- A new ZIM edition is served after `ods restart arviro`.
