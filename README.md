# inventory-framework-mcp

An MCP (Model Context Protocol) server for validating and visualizing [IF (Inventory Framework)](https://github.com/stefvanschie/IF) GUIs used in Minecraft Spigot/Paper plugins.

## What it does

This server lets AI models (Claude, ChatGPT, etc.) inspect IF GUI Java code before it is committed. It can:

- **Validate** IF code for syntax errors, layout issues, pane overlaps, and best practices
- **Render** a visual PNG screenshot of how the GUI will look in-game
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

```bash
npm start
```

The server uses stdio transport for MCP.

## Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "if-visualizer": {
      "command": "node",
      "args": [
        "C:\\Users\\klema\\Documents\\GitHub\\inventory-framework-mcp\\dist\\index.js"
      ]
    }
  }
}
```

*(Adjust the path to your checkout location.)*

## Available Tools

| Tool | Description |
|------|-------------|
| `validate_if_code` | Validates Java IF code and returns errors/warnings |
| `render_gui` | Renders a PNG image of the GUI |
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

## Tech Stack

- Node.js + TypeScript
- MCP SDK (`@modelcontextprotocol/sdk`)
- `jimp` for image rendering (zero native dependencies)
- Regex-based Java tokenizer for IF extraction

## License

MIT
