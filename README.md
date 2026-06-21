<p align="center">
  <img src="docs/images/long-affiche-with-icon.png" alt="Dim0, Your canvas thinks back. Together. Notes, mini-apps, and agents on one infinite board." width="100%" />
</p>

<h1 align="center">Dim0, The Thinking Canvas</h1>

<p align="center">
  <a href="https://github.com/vcmf/dim0/releases"><img src="https://img.shields.io/github/v/release/vcmf/dim0?style=flat&labelColor=171611&color=965e30" alt="Release" /></a>
  <a href="https://github.com/vcmf/dim0/actions/workflows/tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/vcmf/dim0/tests.yml?branch=main&style=flat&labelColor=171611&color=3439c9&label=tests" alt="Tests" /></a>
  <a href="https://github.com/vcmf/dim0/pulse"><img src="https://img.shields.io/github/commit-activity/m/vcmf/dim0?style=flat&labelColor=171611&color=a6395c" alt="Commit activity" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-336d3f?style=flat&labelColor=171611" alt="License: MIT" /></a>
  <a href="https://app.dim0.net"><img src="https://img.shields.io/badge/▶_live_app-app.dim0.net-3439c9?style=flat&labelColor=171611" alt="Live App" /></a>
</p>

<p align="center">
  <a href="https://dim0.net">🌐 Website</a> · <a href="https://app.dim0.net">🚀 Live App</a> · 🤝 Real-time collab · 🔒 Privacy-first · 📄 MIT
</p>

<p align="center">
  Most AI tools start with a chat box and bolt everything else on around it. Dim0 inverts that: the <strong>board is the workspace</strong>, and the agent is one of the things living on it. It reads what's on your canvas, takes real steps with tools, and writes results back as editable nodes: notes, mind maps, and <strong>mini-apps</strong> (real, interactive React apps, not chat-trapped artifacts). Everything is <strong>real-time multiplayer</strong> and <strong>open-source</strong>: self-host it, own your data, switch models whenever the landscape shifts.
</p>

<p align="center">
  ⭐ Star if Dim0 is useful to you. It genuinely helps others find the project.
</p>

![Dim0 app screenshot](docs/images/main-screen.png)
*A single board: notes, a mind map, mini-apps, documents, and the agent - all in the same workspace.*

## Features

- ♾️ **Infinite canvas**: thousands of nodes and nested boards, smooth at scale
- 🎨 **A real whiteboard underneath**: hand-drawn and geometric shapes, arrows, images and media, and a huge icon library (200,000+ via Iconify)
- 🤖 **Board-aware agent**: reads your canvas and selected nodes, takes multi-step tool actions, and writes results back as editable nodes
- 🧩 **Mini-apps**: describe a tool, get a real interactive React app on the board: open it, edit it, export it
- 📝 **Rich notes**: Notion-style rich text, math, code, and sub-pages, edited in place
- 💻 **Code & documents**: run code in sandboxes; drop in files that the agent can search (RAG)
- 🔌 **Bring your own model**: OpenAI, Anthropic, Gemini, Mistral, DeepSeek, Qwen, and more, switch anytime
- 👥 **Real-time multiplayer**: live cursors, shared edits, a shared agent; conflict-free sync, solo or fifty people deep
- 🎬 **Present from the canvas**: drop frames on the board and run them as a slideshow, no export to a separate slides tool
- 🔓 **Open-source & private**: MIT, self-hostable, your data stays yours (no training, no telemetry)

See it in action:

https://github.com/user-attachments/assets/cdc7d3d4-eb59-4d7d-a9ff-6f0206ba82df

## Why Dim0?

You already have a chat assistant, a whiteboard, and a doc tool. Dim0 is what you get when they're the *same* surface, and the AI can actually touch it.

| | **Dim0** | ChatGPT / Claude artifacts | Notion + AI | Miro / tldraw / Excalidraw |
| --- | :---: | :---: | :---: | :---: |
| Infinite spatial canvas | ✅ | ❌ | ❌ | ✅ |
| Agent reads the workspace & writes back | ✅ | ⚠️ chat only | ⚠️ doc only | ❌ |
| Mini-apps: real, editable, persistent React apps | ✅ | ⚠️ trapped in thread | ❌ | ❌ |
| Rich notes (math, code, sub-pages) on the canvas | ✅ | ❌ | ⚠️ docs, not canvas | ❌ |
| Real-time multiplayer | ✅ | ❌ | ✅ | ✅ |
| Bring-your-own model (Claude, GPT, Gemini, …) | ✅ | ❌ | ❌ | ❌ |
| Open-source & self-hostable | ✅ | ❌ | ❌ | ⚠️ partial |
| Your data stays yours (no training, no telemetry) | ✅ | ❌ | ❌ | ⚠️ |

**The short version:** mini-apps and agent output *live on the board* next to your notes and data (editable, persistent, and shared with your team in real time), instead of being buried in a chat thread you'll never find again.

## Quickstart

Run the published images. Docker is the only prerequisite.

```bash
git clone https://github.com/vcmf/dim0.git && cd dim0
cp .env.sample .env          # then set the three keys below
make pull && make run        # pulls latest images and starts everything
```

Set these three in `.env` before `make run`:

| Key | What it powers |
| --- | --- |
| `OPENAI_API_KEY` | the agent's default model + embeddings |
| `OPENROUTER_API_KEY` | access to the other models (Claude, Gemini, Mistral, …) |
| `LINKUP_API_KEY` | web search & page fetch |

Open **http://localhost:3000** → create a board → type a prompt. Done.

Stop it with `make down-run` (add `make kill-run` to wipe volumes).

> Want to hack on the source instead of the images? See **[Run from source](#run-from-source)** below.

## What it is

Most AI tools start with a chat box and bolt the rest of the product on around it. Dim0 goes the other way - the board is the workspace, and the agent is one of the things living on it.

The board holds notes, code sandboxes, mini-apps, documents, nested boards, and presentation frames, all sitting next to each other - and your whole team can be on it at once. The agent can see what's there, take multiple steps with tools, and drop its results back onto the same canvas.

## Node types

Everything on the board is a node:

- **Shapes** - diagrams and spatial structure
- **Notes** - rich text, edited in place
- **Code sandboxes** - write code, run it
- **Mini-apps** - real, interactive React apps: calculators, charts, visualizers, quizzes
- **Documents** - uploaded files, also fed into retrieval
- **Nested boards** - for when one board isn't enough
- **Frames** - turn the canvas into a presentation

![Shapes on a board](docs/images/board-shapes.png)
*Shapes for diagrams, flowcharts, and spatial layout.*

![Rich notes](docs/images/board-notes.png)
*Notes are first-class - rich text, math, code, edited in place.*

![Mini-apps](docs/images/mini-app.png)
*Describe a tool and Dim0 builds a real, interactive app - it lives on the board, reads the data next to it, and you can open, edit, and export the React code.*

![Mindmap from shapes and notes](docs/images/board-mindmap.png)
*Mix shapes and notes to think through a topic spatially.*

https://github.com/user-attachments/assets/ad5de9f4-6f44-43a2-b59a-5279232d7f60

## Canvas engine

The board is built on [canvas-harness](https://github.com/winlp4ever/canvas-harness), a canvas-rendered node-graph library we maintain separately. Boards can hold thousands of nodes and still pan, zoom, and edit smoothly, comparable to tldraw and Excalidraw, and on par with hosted tools like Miro or FigJam.

## Collaboration

Every board is real-time multiplayer. Live cursors, shared edits, and a shared agent - the same board works identically whether you're solo or fifty people deep. Edits sync over WebSocket with operational transforms, so concurrent changes merge without conflicts or lost work.

It's the same canvas either way: no separate "shared mode," no export-to-collaborate step. Open a board, send the link, work together.

## Agent layer

Built on the OpenAI Agents SDK, with board-aware tools wired in:

- Board context - current graph and selected nodes
- Notes - create, edit, link
- Web - search and fetch
- Code - run in Daytona-backed sandboxes
- Mini-apps - generate real, interactive React apps inline
- Memory - semantic store and recall, via Qdrant

Models: OpenAI, Anthropic, Google Gemini, Mistral, Moonshot, DeepSeek, Qwen, Z.ai.

![Ask a question, get a visual answer](docs/images/agent-flow.png)
*Ask a question on the board - the agent answers with a mini-app, a mindmap, or a note, dropped back where you're working.*

## Themes

Light, dark, and a set of paper-and-ink variants. The canvas adapts; so do notes, mini-apps, and shapes.

![Theme showcase](docs/images/themes-showcase.png)
*A few of the available themes.*

## Try it

- Hosted: https://app.dim0.net
- Site: https://dim0.net
- Self-host: see below

## Repo layout

- `backend/` - API, agent logic, prompts, model integrations, persistence
- `webui/` - React frontend (canvas, chat, board UX)
- `build/` - Docker Compose and build helpers

## Getting started

### Prerequisites

- Node.js (LTS)
- `uv` for Python deps
- Docker + Docker Compose (recommended for local services)

### Environment

Copy `.env.sample` to `.env` and fill in the keys.

```bash
cp .env.sample .env
```

At minimum, set these three:

- `OPENAI_API_KEY` - the agent's default model and embeddings
- `OPENROUTER_API_KEY` - access to the other models (Claude, Gemini, Mistral, …)
- `LINKUP_API_KEY` - web search and page fetch

The rest of `.env.sample` covers additional providers and tools.

A couple of things worth knowing:

- Backend and frontend both read the root `.env`
- Only variables prefixed with `VITE_` reach the frontend

### Run published images

```bash
make pull
make run
```

Then open `http://localhost:3000`.

Stop it:

```bash
make down-run
```

Stop it and wipe volumes:

```bash
make kill-run
```

### Run from source

If you'd rather run the source instead of the published images:

#### Local databases

```bash
make up-db
```

#### Backend

```bash
cd backend
uv sync
uv run python -m topix.api.app
```

Port comes from `API_PORT` in `.env` (defaults to `8081`).

#### Frontend

```bash
cd webui
npm install
npm run dev
```

Port comes from `APP_PORT` in `.env` (defaults to `5175`).

## Environment variables

`.env.sample` is the canonical list - ports and origins, model provider keys, search and image provider keys, local service settings, backend auth and tracing. Use it as a checklist when setting things up.

## Docker

Compose stack with Makefile shortcuts.

### Core commands

| Command | What it does |
| --- | --- |
| `make up` | Build if needed and start all services |
| `make up-build` | Rebuild images, then start |
| `make build` | Build images only |
| `make rebuild` | Rebuild without cache |
| `make down` | Stop and remove containers |
| `make kill` | Stop and remove containers, images, and volumes |

### Services and debugging

| Command | What it does |
| --- | --- |
| `make ps` | Show service status |
| `make logs` | Tail logs for all services |
| `make logs-s SERVICE=backend-dev` | Tail logs for one service |
| `make up-s SERVICE=backend-dev` | Start one service |
| `make build-s SERVICE=webui-dev` | Build one service |
| `make restart-s SERVICE=backend-dev` | Rebuild and restart one service |
| `make exec SERVICE=backend-dev CMD="bash"` | Open a shell in a service |

### Databases

| Command | What it does |
| --- | --- |
| `make up-db` | Start only the databases |
| `make down-db` | Stop only the databases |

### Overrides

Override the profile and env file at invocation:

```bash
make up PROFILE=local ENVFILE=.env
```

Or override ports and origins for quick tests:

```bash
make up PROFILE=dev API_PORT=9090 API_HOST_PORT=9090 API_ORIGIN=http://localhost:9090
```

## Images

Public Docker Hub images, for self-hosting:

- `winlp4ever/dim0-backend`
- `winlp4ever/dim0-webui`

```bash
docker pull winlp4ever/dim0-backend:latest
docker pull winlp4ever/dim0-webui:latest
```

Pin a specific release (see [Releases](https://github.com/vcmf/dim0/releases) for the current version) by swapping `latest` for a tag, e.g. `:0.3.41`. To run them locally, use the `make pull` / `make run` flow above.

## Versioning

One semver for the whole product. The repo-root `VERSION` file is the source of truth, and release tooling syncs it into:

- `backend/pyproject.toml`
- `webui/package.json`
- `webui/src-tauri/Cargo.toml`

Bumps use Commitizen with Conventional Commits.

```bash
make version-check
make version-sync
make version-bump
```

GitHub Actions handle the version check, releases, and Docker publishing.

## Troubleshooting

- Frontend can't reach the API? Check `VITE_API_URL` in `.env`.
- Port already in use? Change `API_PORT` or `APP_PORT`.
- Env change not picked up? Restart backend and frontend after editing `.env`.
- Want to see the resolved Compose config? `make config`.
- Backend tests failing with odd import errors (e.g. `cannot import name 'Docstring' from 'griffe'`)? The local `backend/.venv` is stale or half-installed, and a plain `uv sync` won't repair a partially-deleted package. Rebuild it: `rm -rf backend/.venv && uv sync --extra dev`.

## License

MIT.
