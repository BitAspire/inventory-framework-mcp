import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import express from 'express';
import cors from 'cors';
import { GUIModel } from './parser/models.js';
import { extractIFModel } from './parser/if-extractor.js';
import { validateGUIModel } from './validator/engine.js';
import { guiFromMatrixSpec, renderGUI, type MatrixSpec } from './renderer/gui-drawer.js';
import { getItemAtlasEntries } from './renderer/item-atlas.js';
import { resolveLayout, resolveSlot } from './layout/slot-resolution.js';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';

function getResourcesDir(): string {
  if (process.env.IF_RESOURCES_DIR) return process.env.IF_RESOURCES_DIR;
  return path.resolve(__dirname, '..', 'resources');
}

const renderMatrixLegendItemSchema = z.object({
  material: z.string(),
  name: z.string().optional(),
  lore: z.array(z.string()).optional(),
  amount: z.number().int().positive().optional(),
  clickHandler: z.boolean().optional(),
});

const renderMatrixSchema = z.object({
  title: z.string(),
  rows: z.number().int().positive(),
  layout: z.array(z.string()),
  legend: z.record(renderMatrixLegendItemSchema),
});

const renderCommonSchema = z.object({
  scale: z.number().min(1).max(4).optional(),
  texturePath: z.string().optional(),
  outputPath: z.string().optional(),
  hoverSlot: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
  showTooltip: z.boolean().optional(),
});

function readSourceFile(projectRoot: string, sourceFile: string): string {
  const root = path.resolve(projectRoot);
  const filePath = path.isAbsolute(sourceFile) ? sourceFile : path.resolve(root, sourceFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

function applyFixtureSubstitutions(source: string, fixtures: any): string {
  let result = source;
  const lang = fixtures?.lang && typeof fixtures.lang === 'object' ? fixtures.lang as Record<string, unknown> : undefined;
  if (lang) {
    result = result.replace(/\blang\.(?:render|line|get)\(\s*["']([^"']+)["']\s*\)/g, (match, key) => {
      const value = lang[key];
      return typeof value === 'string' ? JSON.stringify(value) : match;
    });
    result = result.replace(/\blang\.(?:guiLoreLines|attachClickTailLore)\(\s*["']([^"']+)["']\s*\)/g, (match, key) => {
      const value = lang[key];
      if (Array.isArray(value)) return `Arrays.asList(${value.map((v) => JSON.stringify(String(v))).join(', ')})`;
      if (typeof value === 'string') return `Arrays.asList(${JSON.stringify(value)})`;
      return match;
    });
  }

  const replacements = fixtures?.replacements && typeof fixtures.replacements === 'object'
    ? fixtures.replacements as Record<string, unknown>
    : undefined;
  if (replacements) {
    for (const [needle, replacement] of Object.entries(replacements)) {
      if (typeof replacement !== 'string' || needle.length === 0) continue;
      result = result.split(needle).join(replacement);
    }
  }

  return result;
}

function mergeFixtures(...candidates: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const merged = candidates.filter(Boolean).reduce<Record<string, unknown>>((acc, current) => ({ ...acc, ...current }), {});
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function buildGuiFromInput(input: {
  code?: string;
  matrix?: MatrixSpec;
  projectRoot?: string;
  sourceFile?: string;
  entryMethod?: string;
  fixtures?: Record<string, unknown>;
  mockParameters?: Record<string, unknown>;
}): { gui: GUIModel | null; notes: string[]; source?: string } {
  if (input.matrix) {
    return {
      gui: guiFromMatrixSpec(input.matrix),
      notes: ['Rendered from matrix specification.'],
    };
  }

  if (input.projectRoot && input.sourceFile) {
    const source = readSourceFile(input.projectRoot, input.sourceFile);
    const fixtures = mergeFixtures(input.fixtures, input.mockParameters);
    const processed = applyFixtureSubstitutions(source, fixtures);
    const parsed = extractIFModel(processed);
    const notes = [`Loaded ${input.sourceFile} from ${path.resolve(input.projectRoot)}.`];
    if (fixtures) notes.push('Applied fixture substitutions.');
    if (parsed.issues.length > 0) notes.push(`Parse hints: ${parsed.issues.length}`);
    if (input.entryMethod) notes.push(`Entry method hint: ${input.entryMethod}`);
    return { gui: parsed.gui, notes, source: processed };
  }

  if (input.code) {
    const parsed = extractIFModel(input.code);
    return { gui: parsed.gui, notes: parsed.issues.length > 0 ? [`Parse hints: ${parsed.issues.length}`] : [] , source: input.code };
  }

  return { gui: null, notes: [] };
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
      description: 'Render a GUI screenshot from IF Java code or a slot matrix. Returns a PNG image plus file metadata.',
      inputSchema: renderCommonSchema.extend({
        code: z.string().optional().describe('Java source code containing IF GUI definitions'),
        matrix: renderMatrixSchema.optional().describe('Matrix-based GUI layout specification'),
      }).refine((data) => Boolean(data.code || data.matrix), {
        message: 'Provide either code or matrix',
      }),
    },
    async (input) => {
      const built = buildGuiFromInput(input);
      if (!built.gui) {
        return {
          content: [{ type: 'text' as const, text: 'Could not parse GUI from input.' }],
        };
      }

      try {
        const rendered = await renderGUI(built.gui, {
          scale: input.scale ?? 2,
          texturePath: input.texturePath,
          outputPath: input.outputPath,
          hoverSlot: input.hoverSlot,
          showTooltip: input.showTooltip,
        });
        const meta = rendered.metadata;
        const notes = [
          ...(built.notes.length > 0 ? built.notes : []),
          `Rendered ${meta.guiType} GUI "${meta.title}" (${meta.columns}x${meta.rows}) with ${meta.renderedItems} item(s).`,
          `Saved preview: ${meta.imagePath}`,
          meta.texturedItems > 0 ? `Loaded ${meta.texturedItems} item texture(s).` : undefined,
          meta.fallbackItems.length > 0 ? `Fallback icons: ${meta.fallbackItems.join(', ')}` : undefined,
          meta.unknownMaterials.length > 0 ? `Unknown atlas materials: ${meta.unknownMaterials.join(', ')}` : undefined,
        ].filter(Boolean).join('\n');
        const metadata = {
          imagePath: meta.imagePath,
          width: meta.width,
          height: meta.height,
          unknownMaterials: meta.unknownMaterials,
          slots: meta.slots,
        };
        return {
          content: [
            {
              type: 'image' as const,
              data: rendered.base64,
              mimeType: 'image/png',
            },
            { type: 'text' as const, text: notes },
            { type: 'text' as const, text: JSON.stringify(metadata, null, 2) },
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
    'render_project_gui',
    {
      description: 'Render a GUI from a project source file with optional fixture substitutions.',
      inputSchema: z.object({
        projectRoot: z.string().describe('Root of the project to read from'),
        sourceFile: z.string().describe('Project-relative or absolute Java source file'),
        entryMethod: z.string().optional().describe('Entry method hint for the GUI'),
        fixtures: z.record(z.string(), z.any()).optional().describe('Fixture data such as lang and replacements'),
        mockParameters: z.record(z.string(), z.any()).optional().describe('Alias for fixture data'),
      }).and(renderCommonSchema),
    },
    async (input) => {
      const built = buildGuiFromInput(input);
      if (!built.gui) {
        return {
          content: [{ type: 'text' as const, text: 'Could not resolve GUI from project source.' }],
        };
      }

      const rendered = await renderGUI(built.gui, {
        scale: input.scale ?? 2,
        texturePath: input.texturePath,
        outputPath: input.outputPath,
        hoverSlot: input.hoverSlot,
        showTooltip: input.showTooltip,
      });

      const meta = rendered.metadata;
      const notes = [
        ...(built.notes.length > 0 ? built.notes : []),
        `Rendered ${meta.guiType} GUI "${meta.title}" (${meta.columns}x${meta.rows}).`,
        `Saved preview: ${meta.imagePath}`,
      ].join('\n');
      const metadata = {
        imagePath: meta.imagePath,
        width: meta.width,
        height: meta.height,
        unknownMaterials: meta.unknownMaterials,
        slots: meta.slots,
      };

      return {
        content: [
          { type: 'image' as const, data: rendered.base64, mimeType: 'image/png' },
          { type: 'text' as const, text: notes },
          { type: 'text' as const, text: JSON.stringify(metadata, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    'inspect_gui_slot',
    {
      description: 'Inspect the effective item and contributors for a GUI slot.',
      inputSchema: renderCommonSchema.extend({
        code: z.string().optional().describe('Java source code containing IF GUI definitions'),
        matrix: renderMatrixSchema.optional().describe('Matrix-based GUI layout specification'),
        x: z.number().int().describe('Slot column'),
        y: z.number().int().describe('Slot row'),
      }).refine((data) => Boolean(data.code || data.matrix), {
        message: 'Provide either code or matrix',
      }),
    },
    async (input) => {
      const built = buildGuiFromInput(input);
      if (!built.gui) {
        return {
          content: [{ type: 'text' as const, text: 'Could not parse GUI from input.' }],
        };
      }

      const layout = resolveLayout(built.gui);
      const slot = resolveSlot(layout, input.x, input.y);
      if (!slot?.winner) {
        return {
          content: [{ type: 'text' as const, text: `No effective item found at slot (${input.x}, ${input.y}).` }],
        };
      }

      const winner = slot.winner;
      const payload = {
        slot: [input.x, input.y],
        effectiveItem: {
          material: winner.item.material,
          displayName: winner.item.displayName,
          lore: winner.item.lore,
          amount: winner.item.amount,
          hasClickHandler: Boolean(winner.item.hasClickHandler),
          priority: winner.priority,
        },
        contributors: slot.contributors.map((c) => ({
          pane: c.pane.type,
          priority: c.priority,
          material: c.item.material,
          displayName: c.item.displayName,
          position: [c.col, c.row],
          source: c.pane.positionSource ?? 'default',
        })),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
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
  const layout = resolveLayout(gui);
  const columns = layout.columns;
  const rows = layout.rows;

  if (gui.type === 'chest' && gui.rows > 6) {
    suggestions.push('- GUI has more than 6 rows. Chest GUIs in Minecraft are limited to 6 rows.');
  }

  const usedSlots = layout.slots.size;
  const totalSlots = columns * rows;
  if (usedSlots < totalSlots * 0.3) {
    suggestions.push('- GUI is very sparse. Consider reducing pane sizes or grouping items more tightly.');
  }

  const hasClose = [...layout.slots.values()].some((slot) => {
    const winner = slot.winner;
    return Boolean(
      winner &&
      slot.col === columns - 1 &&
      slot.row === 0 &&
      /close|back|exit|cancel/i.test(winner.item.displayName || '')
    );
  });
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

    const transports: Record<string, StreamableHTTPServerTransport> = {};

    app.get('/', (_req, res) => {
      res.json({
        name: 'inventory-framework-mcp',
        version: '0.1.0',
        status: 'running',
        endpoints: {
          mcp: '/mcp',
          health: '/health',
        },
      });
    });

    app.all('/mcp', async (req, res) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport = sessionId ? transports[sessionId] : undefined;

        if (transport) {
          await transport.handleRequest(req, res, req.body);
          return;
        }

        if (req.method !== 'POST' || !req.body || req.body.method !== 'initialize') {
          res.status(400).json({ error: 'Session required. Send initialize first.' });
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport!;
          },
        });
        const srv = createServer();
        await srv.connect(transport);
        transport.onclose = () => {
          for (const [k, v] of Object.entries(transports)) {
            if (v === transport) delete transports[k];
          }
        };
        transport.onerror = (err) => {
          console.error('Transport error:', err);
        };
        await transport.handleRequest(req, res, req.body);
      } catch (err: any) {
        console.error('MCP error:', err);
        if (!res.headersSent) res.status(500).end();
      }
    });

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', sessions: Object.keys(transports).length });
    });

    await new Promise<void>((resolve, reject) => {
      const srv = app.listen(port, host, () => {
        console.error(`IF Visualizer MCP Server running on http://${host}:${port}/mcp`);
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
