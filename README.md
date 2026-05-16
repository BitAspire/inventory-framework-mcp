# inventory-framework-mcp

An MCP (Model Context Protocol) server for validating and visualizing [IF (Inventory Framework)](https://github.com/stefvanschie/IF) GUIs used in Minecraft Spigot/Paper plugins.

## What it does

This server lets AI models (Claude, ChatGPT, etc.) inspect IF GUI Java code before it is committed. It can:

- **Validate** IF code for syntax errors, layout issues, pane overlaps, and best practices
- **Render** a visual PNG screenshot of how the GUI will look in-game
- **Render with local textures** from bundled `assets/textures` or a resource pack when a `texturePath` is provided
- **Analyze** UX layout and suggest improvements
- **List** known Minecraft items to help pick correct `Material` names
- **Docs** provide quick IF documentation snippets

## Installation

```bash
npm install
npm run build
```

Requires Node.js 18+.

## Running

### Local stdio mode (default)

```bash
npm start
```

The server runs on stdio transport — spawn it from an MCP client directly.

### HTTP/SSE mode (for remote hosting)

```bash
npm run serve
```

Starts an HTTP server on port 3000 using the SSE transport protocol.

Custom port/host:
```bash
PORT=8080 HOST=0.0.0.0 npm run serve
```

## Client Configuration

### Local (via stdio)

Add to your `claude_desktop_config.json` or `~/.config/zed/settings.json`:

```json
{
  "mcpServers": {
    "if-visualizer": {
      "command": "node",
      "args": ["C:\\cesta\\k\\inventory-framework-mcp\\dist\\index.js"]
    }
  }
}
```

### Remote (via HTTP/SSE)

For Zed editor, add to `~/.config/zed/settings.json`:

```json
{
  "mcp_servers": {
    "if-visualizer": {
      "url": "https://tvoje-domena.cz/sse"
    }
  }
}
```

For other MCP clients, point them to `https://tvoje-domena.cz/sse`.

### Environment variables

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default: 3000) |
| `HOST` | Bind address (default: 0.0.0.0) |
| `IF_RESOURCES_DIR` | Override path to `resources/` directory |
| `IF_ASSETS_DIR` | Override path to `assets/` directory |

## Available Tools

| Tool | Description |
|------|-------------|
| `validate_if_code` | Validates Java IF code and returns errors/warnings |
| `render_gui` | Renders a PNG image of the GUI using bundled textures when available. Optional `texturePath` can point to an additional resource pack or texture folder |
| `analyze_layout` | Provides UI/UX suggestions |
| `list_items` | Lists Minecraft items (optionally filtered) |
| `get_if_docs` | Returns IF documentation for a topic |

## Example Usage

Send Java IF code to `render_gui`:

```java
ChestGui gui = new ChestGui(5, "Shop");
OutlinePane pane = new OutlinePane(0, 0, 9, 5);
pane.addItem(new GuiItem(new ItemStack(Material.DIAMOND_SWORD)));
gui.addPane(pane);
```

The tool returns a base64 PNG showing the chest GUI layout with item placeholders.

### Optional resource pack textures

By default, `render_gui` looks in this repository's `assets/textures` folder. It also accepts `texturePath` for an extra resource pack or texture folder. The renderer looks for PNGs in these layouts:

```text
assets/textures/item/diamond_sword.png
assets/textures/block/stone.png
<texturePath>/assets/minecraft/textures/item/diamond_sword.png
<texturePath>/assets/minecraft/textures/block/stone.png
<texturePath>/item/diamond_sword.png
<texturePath>/block/stone.png
<texturePath>/diamond_sword.png
```

If a texture is not found, the renderer falls back to generated pixel-style icons. This keeps the MCP usable without bundling Minecraft assets.
For block materials, it also tries common vanilla suffixes such as `_side`, `_top`, `_front`, `_bottom`, and `_end`.

The render response includes a short metadata text block after the image, including GUI type, size, rendered item count, loaded texture count, fallback materials, and unknown atlas materials.

## Tech Stack

- Node.js + TypeScript
- MCP SDK (`@modelcontextprotocol/sdk`)
- `jimp` for image rendering (zero native dependencies)
- Regex-based Java tokenizer for IF extraction

## License

MIT
