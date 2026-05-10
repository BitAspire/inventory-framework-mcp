# Agent Instructions for inventory-framework-mcp

## Purpose
This MCP server helps AI models validate and preview IF (Inventory Framework) GUIs before the code is committed to a Minecraft plugin.

## When to use
- The user is writing or reviewing IF GUI Java code
- They want to check how the GUI will look in-game
- They need to find the correct `Material` name for an item
- They want a quick lint check for common IF mistakes

## Workflow
1. If the user pastes IF Java code, always run `validate_if_code` first.
2. If validation returns errors, suggest fixes before rendering.
3. Run `render_gui` to show a visual preview (scale 2 is a good default).
4. If the layout looks sparse or has UX issues, run `analyze_layout`.
5. If the user asks "what item should I use for X?", run `list_items` with a query.
6. If the user asks about IF concepts (panes, GuiItem, XML), run `get_if_docs`.

## Important notes
- The server parses **Java fluent API** code (e.g., `new ChestGui(5, "Title")`, `addPane`, `bindItem`).
- It does **not** execute Minecraft or Bukkit – it only parses and renders a static image.
- Item textures are rendered as colored placeholders with the material's representative color. Real Minecraft textures are not included to avoid copyright issues.
- Supported GUI types: `ChestGui`, `HopperGui`, `DropperGui`, `DispenserGui`.
- Supported pane types: `OutlinePane`, `StaticPane`, `PaginatedPane`, `PatternPane`, `MasonryPane`.
- The renderer uses `jimp` (pure JS) so it works on any host without native dependencies.

## MCP Server Name
`if-visualizer`

## Transport
Stdio (`node dist/index.js`)

## Example prompts for the agent
- "Validate this IF code: ```java ... ```"
- "Render a preview of this GUI: ```java ... ```"
- "What items match 'sword'?"
- "Explain how OutlinePane works"
