# Inventory Framework MCP Server

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-000000)][mcp-spec]
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> An [MCP (Model Context Protocol)][mcp-spec] server for validating, analyzing, and rendering [IF (Inventory Framework)][if-repo] GUIs — letting AI assistants preview Minecraft plugin GUIs **before the code is ever committed**.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Usage](#usage)
  - [Local (stdio)](#local-stdio)
  - [Remote (Streamable HTTP)](#remote-streamable-http)
  - [Docker](#docker)
  - [Dokploy Deployment](#dokploy-deployment)
- [Client Configuration](#client-configuration)
  - [Claude Desktop](#claude-desktop)
  - [Zed Editor](#zed-editor)
  - [Via mcp-remote (any client)](#via-mcp-remote-any-client)
- [Tools Reference](#tools-reference)
  - [`validate_if_code`](#validate_if_code)
  - [`render_gui`](#render_gui)
  - [`analyze_layout`](#analyze_layout)
  - [`list_items`](#list_items)
  - [`get_if_docs`](#get_if_docs)
- [Example Workflow](#example-workflow)
- [Texture System](#texture-system)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Development](#development)
- [Environment Variables](#environment-variables)
- [License](#license)

---

## Features

- ✅ **Validate** IF Java code — syntax errors, pane overlaps, row limits, best practices
- 🎨 **Render** GUIs as PNG images — see exactly how the chest/dropper/hopper will look in-game
- 📦 **Real textures** — bundled with 1000+ Minecraft item and block textures; also accepts custom resource packs
- 🔍 **Analyze layout** — UX suggestions (sparse GUIs, missing close buttons, oversized panes)
- 📋 **Item lookup** — search 1000+ Minecraft `Material` names and their categories
- 📚 **IF documentation** — quick-reference docs for GUI types, panes, items, and XML
- 🖥️ **Two transport modes** — local stdio for desktop clients, remote HTTP for cloud-hosted AI
- 🐳 **Docker-ready** — multi-stage build, health check, Dokploy-compatible

---

## How It Works

When an AI assistant (Claude Desktop, Zed, Cursor, etc.) receives Java code that uses the IF library, it can invoke this MCP server to:

1. **Parse** the Java fluent API code with a regex-based tokenizer
2. **Validate** the GUI model against known IF rules
3. **Render** a pixel-accurate PNG preview of the GUI layout
4. **Return** the image + metadata back to the AI

The server does **not** execute Minecraft or Bukkit. It works purely as a static analyzer and renderer, making it safe to run anywhere.

```
  AI Assistant                    MCP Server                     Minecraft Server
      │                              │                                │
      │  "ChestGui(5, "Shop")..."    │                                │
      │ ──────────────────────────►  │                                │
      │                              │  ┌─ parse & validate ──┐       │
      │                              │  │  render preview     │       │
      │                              │  └─────────────────────┘       │
      │   PNG preview + metadata     │                                │
      │ ◄──────────────────────────  │                                │
      │                              │        "looks good!"           │
      │ ─────────────────────────────────────────────────────────►    │
```

---

## Installation

```bash
npm install
npm run build
```

> **Requires** Node.js 18+.

---

## Usage

### Local (stdio)

Run the server in stdio mode — it communicates over standard input/output, which is how most desktop MCP clients spawn subprocesses.

```bash
npm start
```

### Remote (Streamable HTTP)

Run as an HTTP server for remote/cloud deployment. Uses the [Streamable HTTP transport][mcp-streamable] (protocol 2025-11-25).

```bash
npm run serve
```

Custom host and port:

```bash
PORT=8080 HOST=0.0.0.0 npm run serve
```

The server listens on `/mcp` for all MCP traffic (GET, POST, DELETE).

### Docker

```bash
docker build -t inventory-framework-mcp .
docker run -d \
  -p 3000:3000 \
  --name if-mcp \
  inventory-framework-mcp
```

The container starts in HTTP mode on port 3000 with a built-in health check at `/health`.

### Dokploy Deployment

This repository includes a `Dockerfile` that Dokploy auto-detects:

| Setting        | Value          |
|----------------|----------------|
| Dockerfile     | `Dockerfile`   |
| Build stage    | `production`   |
| Container port | `3000`         |
| Health check   | `/health`      |

To use custom textures, add a bind mount:

```bash
/path/to/textures:/app/assets/textures
```

Or set `IF_ASSETS_DIR=/data/textures`.

---

## Client Configuration

### Claude Desktop

Add to `claude_desktop_config.json`:

**Local:**
```json
{
  "mcpServers": {
    "if-visualizer": {
      "command": "node",
      "args": ["/path/to/inventory-framework-mcp/dist/index.js"]
    }
  }
}
```

**Remote:**
```json
{
  "mcpServers": {
    "if-visualizer": {
      "url": "https://your-domain.com/mcp"
    }
  }
}
```

### Zed Editor

Add to `~/.config/zed/settings.json`:

**Local:**
```json
{
  "mcp_servers": {
    "if-visualizer": {
      "command": "node",
      "args": ["C:\\path\\to\\inventory-framework-mcp\\dist\\index.js"]
    }
  }
}
```

**Remote:**
```json
{
  "context_servers": {
    "if-visualiser": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-domain.com/mcp"],
      "env": {}
    }
  }
}
```

### Via mcp-remote (any client)

For any MCP client that only supports stdio, use [`mcp-remote`][mcp-remote] as a bridge:

```json
{
  "mcpServers": {
    "if-visualizer": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-domain.com/mcp"]
    }
  }
}
```

---

## Tools Reference

### `validate_if_code`

Scans IF Java code for common mistakes and best-practice violations.

| Check | Description |
|-------|-------------|
| Pane overlaps | Detects panes that overlap each other |
| Row limits | Warns if a ChestGui exceeds 6 rows |
| Invalid GUI types | Rejects unsupported GUI types |
| Material names | Flags unknown Bukkit Material values |

**Input:** `code` (string) — Java source code with IF GUI definitions.

### `render_gui`

Renders a PNG screenshot of the GUI exactly as it would appear in-game.

| Parameter     | Type   | Default | Description |
|---------------|--------|---------|-------------|
| `code`        | string | —       | Java source code (required) |
| `scale`       | number | `2`     | Image scale factor (1–4) |
| `texturePath` | string | —       | Extra resource pack or texture folder path |

The response includes:
- A `base64`-encoded PNG image (type `image`)
- Metadata: GUI type, title, dimensions, rendered/fetched item counts

### `analyze_layout`

Provides UX suggestions based on the GUI layout:

- Sparse GUIs (fewer than 30% of slots filled)
- Missing close/back buttons in the top-right corner
- Chest GUIs taller than 6 rows
- Any validation issues from `validate_if_code`

**Input:** `code` (string) — Java source code with IF GUI definitions.

### `list_items`

Lists known Minecraft item `Material` names from the built-in atlas.

**Input:** `query` (string, optional) — prefix filter (e.g., `"diamond"` returns `DIAMOND`, `DIAMOND_SWORD`, `DIAMOND_PICKAXE`, …).

### `get_if_docs`

Returns IF documentation for a given topic.

| Topic          | Description |
|----------------|-------------|
| `gui`          | ChestGui, HopperGui, DropperGui, DispenserGui |
| `panes`        | OutlinePane, StaticPane, PaginatedPane, PatternPane, MasonryPane |
| `outline_pane` | OutlinePane API |
| `static_pane`  | StaticPane API |
| `gui_item`     | GuiItem, ItemStack, click handlers |
| `xml`          | XML-based GUI definition syntax |

**Input:** `topic` (string) — one of the topics above.

---

## Example Workflow

1. The AI assistant receives Java code from the user:

```java
ChestGui gui = new ChestGui(5, "Shop");
OutlinePane pane = new OutlinePane(0, 0, 9, 5);

pane.addItem(new GuiItem(new ItemStack(Material.DIAMOND_SWORD)));
pane.addItem(new GuiItem(new ItemStack(Material.DIAMOND_PICKAXE)));
pane.addItem(new GuiItem(new ItemStack(Material.EMERALD)));
pane.addItem(new GuiItem(new ItemStack(Material.APPLE)));

gui.addPane(pane);
```

2. The assistant calls `validate_if_code` to check for issues.
3. The assistant calls `render_gui` to generate a visual preview.
4. The assistant calls `analyze_layout` for UX suggestions.
5. Based on the feedback, the assistant or user iterates on the code.

The rendered output is a Minecraft-style chest GUI with item placeholders — diamonds, emeralds, and apples arranged in the grid, using fallback colors or real textures when available.

---

## Texture System

The renderer includes **1000+ real Minecraft item and block textures** bundled in `assets/textures/`. When rendering, it searches for matching PNG files in this order:

```
assets/textures/item/<material>.png
assets/textures/block/<material>.png
<texturePath>/assets/minecraft/textures/item/<material>.png
<texturePath>/assets/minecraft/textures/block/<material>.png
<texturePath>/item/<material>.png
<texturePath>/block/<material>.png
<texturePath>/<material>.png
```

For block materials, it also tries common suffixes: `_side`, `_top`, `_front`, `_bottom`, `_end`.

If no texture is found, the renderer falls back to **auto-generated pixel-style icons** using each material's representative color from the built-in atlas. This guarantees a useful preview even without any texture files.

The render metadata reports:
- **Textured items** — how many real textures were loaded
- **Fallback items** — materials rendered with generated icons
- **Unknown materials** — materials not found in the atlas at all

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Express HTTP Server (port 3000)                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  GET  /health  ── health check                            │ │
│  │  POST /mcp     ── JSON-RPC requests (initialize,          │ │
│  │  GET  /mcp     ── SSE stream for notifications            │ │
│  │  DEL  /mcp     ── session teardown                        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  McpServer (per-session instance)                          │ │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐ │ │
│  │  │validate  │  │ render   │  │ analyze   │  │ list     │ │ │
│  │  │_if_code  │  │ _gui     │  │ _layout   │  │ _items   │ │ │
│  │  └──────────┘  └──────────┘  └───────────┘  └──────────┘ │ │
│  │  ┌──────────┐                                            │ │
│  │  │get_if    │                                            │ │
│  │  │_docs     │                                            │ │
│  │  └──────────┘                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Parser (regex-based Java tokenizer)                       │ │
│  │  Renderer (Jimp image processing)                          │ │
│  │  Validator (IF rule engine)                                │ │
│  │  Item Atlas (material → color/texture mapping)             │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

Each SSE or Streamable HTTP session gets its own `McpServer` instance, so multiple AI assistants can use the server concurrently without interference.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Node.js](https://nodejs.org) 18+ |
| Language | [TypeScript](https://www.typescriptlang.org) 5.8 |
| MCP Framework | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 1.29 |
| HTTP Server | [Express](https://expressjs.com) 5.x |
| Image Processing | [`jimp`](https://github.com/jimp-dev/jimp) 1.6 (pure JS, no native deps) |
| Schema Validation | [`zod`](https://zod.dev) 3.24 |
| Java Parsing | Custom regex-based tokenizer |
| Bundled Assets | 1000+ Minecraft item/block textures |

---

## Development

```bash
# Install dependencies
npm install

# Run in dev mode (auto-restart on changes, stdio)
npm run dev

# Run in dev mode (HTTP)
npm run dev:http

# Build
npm run build

# Type-check
npx tsc --noEmit
```

### Project Structure

```
src/
├── index.ts                    Server entry point + HTTP routes
├── parser/
│   ├── tokenizer.ts            Java source → token stream
│   ├── if-extractor.ts         Tokens → GUIModel
│   └── models.ts               TypeScript interfaces for IF concepts
├── validator/
│   └── engine.ts               Rule-based validation engine
├── renderer/
│   ├── gui-drawer.ts           Jimp-based GUI renderer
│   └── item-atlas.ts           Material → color/texture lookup
assets/
└── textures/                   Minecraft item/block PNGs
resources/
└── if-docs.json                IF documentation snippets
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port (remote mode) |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `SERVE` | — | Set to `1` to enable HTTP mode |
| `IF_RESOURCES_DIR` | `./resources` | Override path to `resources/` directory |
| `IF_ASSETS_DIR` | `./assets` | Override path to `assets/` directory |
| `NODE_ENV` | `production` | Runtime environment |

---

## License

[MIT](LICENSE)

---

[mcp-spec]: https://spec.modelcontextprotocol.io
[mcp-streamable]: https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/
[mcp-remote]: https://github.com/anomalyco/mcp-remote
[if-repo]: https://github.com/stefvanschie/IF
