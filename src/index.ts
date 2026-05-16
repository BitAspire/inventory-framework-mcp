import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import express from 'express';
import cors from 'cors';
import { extractIFModel } from './parser/if-extractor.js';
import { validateGUIModel } from './validator/engine.js';
import { renderGUI } from './renderer/gui-drawer.js';
import { getItemAtlasEntries } from './renderer/item-atlas.js';
import * as fs from 'fs';
import * as path from 'path';

function getResourcesDir(): string {
  if (process.env.IF_RESOURCES_DIR) return process.env.IF_RESOURCES_DIR;
  return path.resolve(__dirname, '..', 'resources');
}

const ifDocsPath = path.resolve(getResourcesDir(), 'if-docs.json');
const ifDocs = JSON.parse(fs.readFileSync(ifDocsPath, 'utf-8')) as Record<string, string>;

function createServer(): McpServer {
  const server = new McpServer({
    name: 'inventory-framework-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'validate_if_code',
    {
      description: 'Validate IF (Inventory Framework) Java GUI code for syntax errors, layout issues, and best practices.',
      inputSchema: z.object({
        code: z.string().describe('Java source code containing IF GUI definitions'),
      }),
    },
    async ({ code }) => {
      const parsed = extractIFModel(code);
      const validationIssues = parsed.gui ? validateGUIModel(parsed.gui) : [];
      const allIssues = [...parsed.issues, ...validationIssues];

      if (allIssues.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No issues found. GUI looks good!' }],
        };
      }

      const lines = allIssues.map(
        (i) => `[${i.severity.toUpperCase()}] ${i.ruleId}: ${i.message}${i.location ? ` (${i.location})` : ''}`
      );

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  server.registerTool(
    'render_gui',
    {
      description: 'Render a GUI screenshot from IF Java code. Returns a PNG image.',
      inputSchema: z.object({
        code: z.string().describe('Java source code containing IF GUI definitions'),
        scale: z.number().min(1).max(4).optional().describe('Scale factor for the output image (1-4)'),
        texturePath: z.string().optional().describe('Optional local path to a Minecraft resource pack or texture folder. Supports assets/minecraft/textures/item and block PNGs.'),
      }),
    },
    async ({ code, scale, texturePath }) => {
      const parsed = extractIFModel(code);
      if (!parsed.gui) {
        return {
          content: [{ type: 'text' as const, text: 'Could not parse GUI from code.' }],
        };
      }
      try {
        const rendered = await renderGUI(parsed.gui, { scale: scale ?? 2, texturePath });
        const meta = rendered.metadata;
        const notes = [
          `Rendered ${meta.guiType} GUI "${meta.title}" (${meta.columns}x${meta.rows}) with ${meta.renderedItems} item(s).`,
          meta.texturedItems > 0 ? `Loaded ${meta.texturedItems} item texture(s).` : undefined,
          meta.fallbackItems.length > 0 ? `Fallback icons: ${meta.fallbackItems.join(', ')}` : undefined,
          meta.unknownMaterials.length > 0 ? `Unknown atlas materials: ${meta.unknownMaterials.join(', ')}` : undefined,
        ].filter(Boolean).join('\n');
        return {
          content: [
            {
              type: 'image' as const,
              data: rendered.base64,
              mimeType: 'image/png',
            },
            { type: 'text' as const, text: notes },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Rendering failed: ${err.message}` }],
        };
      }
    }
  );

  server.registerTool(
    'analyze_layout',
    {
      description: 'Analyze the UI/UX layout of an IF GUI and suggest improvements.',
      inputSchema: z.object({
        code: z.string().describe('Java source code containing IF GUI definitions'),
      }),
    },
    async ({ code }) => {
      const parsed = extractIFModel(code);
      if (!parsed.gui) {
        return {
          content: [{ type: 'text' as const, text: 'Could not parse GUI from code.' }],
        };
      }
      const validationIssues = validateGUIModel(parsed.gui);
      const suggestions = generateLayoutSuggestions(parsed.gui, validationIssues);
      return {
        content: [{ type: 'text' as const, text: suggestions }],
      };
    }
  );

  server.registerTool(
    'list_items',
    {
      description: 'List known Minecraft items available in the item atlas. Useful for referencing correct Material names.',
      inputSchema: z.object({
        query: z.string().optional().describe('Optional prefix filter for item names'),
      }),
    },
    async ({ query }) => {
      const entries = getItemAtlasEntries(query);
      const lines = entries.map((e) => `${e.id} (${e.category})`);
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') || 'No items found.' }],
      };
    }
  );

  server.registerTool(
    'get_if_docs',
    {
      description: 'Get IF (Inventory Framework) documentation for a specific topic.',
      inputSchema: z.object({
        topic: z.string().describe('Topic name, e.g. gui, panes, outline_pane, static_pane, gui_item, xml'),
      }),
    },
    async ({ topic }) => {
      const text = ifDocs[topic.toLowerCase()];
      if (!text) {
        return {
          content: [{ type: 'text' as const, text: `Unknown IF topic: ${topic}. Available topics: ${Object.keys(ifDocs).join(', ')}` }],
        };
      }
      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );

  return server;
}

function generateLayoutSuggestions(gui: any, issues: any[]): string {
  const suggestions: string[] = [];

  if (gui.type === 'chest' && gui.rows > 6) {
    suggestions.push('- GUI has more than 6 rows. Chest GUIs in Minecraft are limited to 6 rows.');
  }

  const totalPaneSlots = gui.panes.reduce((acc: number, p: any) => acc + p.length * p.height, 0);
  const totalItems = gui.panes.reduce((acc: number, p: any) => acc + p.items.length, 0) + gui.orphanItems.length;
  if (totalItems < totalPaneSlots * 0.3) {
    suggestions.push('- GUI is very sparse. Consider reducing pane sizes or grouping items more tightly.');
  }

  const hasClose = gui.panes.some((p: any) =>
    p.items.some(
      (i: any) =>
        i.slotX === p.length - 1 && i.slotY === 0 && /close|back|exit|cancel/i.test(i.displayName || '')
    )
  );
  if (!hasClose) {
    suggestions.push('- No close/back button detected in the top-right corner. Consider adding one for better UX.');
  }

  if (issues.length > 0) {
    suggestions.push('');
    suggestions.push('Validation issues:');
    suggestions.push(...issues.map((i) => `- [${i.severity}] ${i.message}`));
  }

  return suggestions.join('\n') || 'Layout looks good. No suggestions.';
}

async function main() {
  const args = process.argv.slice(2);
  const useHttp = args.includes('--http') || args.includes('--serve') || process.env.SERVE === '1';
  const port = parseInt(process.env.PORT || args.find(a => a.startsWith('--port='))?.split('=')[1] || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  console.error(`resources dir: ${getResourcesDir()}`);
  console.error(`ifDocs path: ${ifDocsPath}`);
  console.error(`ifDocs topics: ${Object.keys(ifDocs).length}`);

  if (useHttp) {
    const app = express();
    app.use(cors());
    app.use(express.json());

    const transports: Record<string, SSEServerTransport> = {};

    app.get('/', (_req, res) => {
      res.json({
        name: 'inventory-framework-mcp',
        version: '0.1.0',
        status: 'running',
        endpoints: {
          sse: '/sse',
          messages: 'POST /messages',
          health: '/health',
        },
      });
    });

    app.get('/sse', async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const transport = new SSEServerTransport('/messages', res);
      transports[transport.sessionId] = transport;
      const keepalive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 20000);
      res.on('close', () => {
        clearInterval(keepalive);
        delete transports[transport.sessionId];
      });
      const srv = createServer();
      await srv.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      const transport = transports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).json({ error: 'No transport found for sessionId' });
      }
    });

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', sessions: Object.keys(transports).length });
    });

    await new Promise<void>((resolve, reject) => {
      const srv = app.listen(port, host, () => {
        console.error(`IF Visualizer MCP Server running on http://${host}:${port}/sse`);
        resolve();
      });
      srv.on('error', reject);
    });
  } else {
    const transport = new StdioServerTransport();
    const srv = createServer();
    await srv.connect(transport);
    console.error('IF Visualizer MCP Server running on stdio');
  }
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
