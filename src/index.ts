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
  title: z.string().optional(),
  rows: z.number().int().positive(),
  layout: z.array(z.string()),
  legend: z.record(renderMatrixLegendItemSchema),
});

const renderCommonShape = {
  scale: z.number().min(1).max(4).optional().describe('Scale factor for the output image (1-4)'),
  texturePath: z.string().optional().describe('Optional path to a Minecraft resource pack or texture folder'),
  outputPath: z.string().optional().describe('Optional output PNG path'),
  hoverSlot: z.object({ x: z.number().int(), y: z.number().int() }).optional().describe('Optional slot to show a tooltip for'),
  showTooltip: z.boolean().optional().describe('Whether to render tooltip for hoverSlot'),
};

const projectGuiShape = {
  projectRoot: z.string().optional().describe('Optional root directory to read from when inline content is not provided'),
  sourceFile: z.string().optional().describe('Project-relative or absolute Java source file path, or key into files/supportFiles'),
  code: z.string().optional().describe('Inline Java source code to render. Preferred for remote MCP clients.'),
  files: z.record(z.string(), z.string()).optional().describe('Inline support files keyed by project-relative path. If sourceFile matches a key, that file is rendered.'),
  supportFiles: z.record(z.string(), z.string()).optional().describe('Alias for files: additional inline files keyed by project-relative path'),
  langFileContent: z.string().optional().describe('Inline lang.yml content to use for lang.* substitutions'),
  langYaml: z.string().optional().describe('Alias for langFileContent'),
  className: z.string().optional().describe('Fully qualified class name to render'),
  methodName: z.string().optional().describe('Static method or entry point to render'),
  entryMethod: z.string().optional().describe('Entry method hint for the GUI'),
  fixture: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe('Fixture name or inline mock data'),
  fixtures: z.record(z.string(), z.any()).optional().describe('Fixture data such as lang and replacements'),
  mockParameters: z.record(z.string(), z.any()).optional().describe('Alias for fixture data'),
};

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

function loadFixturePreset(name: string, projectRoot?: string): Record<string, unknown> | undefined {
  const safeName = name.endsWith('.json') ? name : `${name}.json`;
  const candidates = [
    projectRoot ? path.resolve(projectRoot, 'mcp-fixtures', safeName) : undefined,
    projectRoot ? path.resolve(projectRoot, '.mcp', 'fixtures', safeName) : undefined,
    path.resolve(getResourcesDir(), 'fixtures', safeName),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }

  return undefined;
}

function mergeFixtures(...candidates: Array<unknown>): Record<string, unknown> | undefined {
  const records = candidates.filter((candidate): candidate is Record<string, unknown> => {
    return Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate);
  });
  const merged = records.reduce<Record<string, unknown>>((acc, current) => ({ ...acc, ...current }), {});
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSimpleLangYaml(content: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const stack: Array<{ indent: number; key: string }> = [];
  let currentListKey: string | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();

    if (trimmed.startsWith('- ') && currentListKey) {
      const value = stripYamlQuotes(trimmed.slice(2));
      const existing = result[currentListKey];
      if (Array.isArray(existing)) existing.push(value);
      continue;
    }

    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;

    const key = stripYamlQuotes(trimmed.slice(0, separator));
    const value = trimmed.slice(separator + 1).trim();
    const fullKey = [...stack.map((entry) => entry.key), key].join('.');

    if (!value) {
      stack.push({ indent, key });
      result[fullKey] = [];
      currentListKey = fullKey;
      continue;
    }

    currentListKey = undefined;
    if (value.startsWith('[') && value.endsWith(']')) {
      result[fullKey] = value.slice(1, -1).split(',').map((part) => stripYamlQuotes(part)).filter(Boolean);
    } else {
      result[fullKey] = stripYamlQuotes(value);
    }
  }

  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && value.length === 0) delete result[key];
  }

  return result;
}

function findInlineFile(files: Record<string, string> | undefined, sourceFile: string | undefined): { path: string; content: string } | undefined {
  if (!files) return undefined;
  if (sourceFile && Object.prototype.hasOwnProperty.call(files, sourceFile)) return { path: sourceFile, content: files[sourceFile] };
  if (sourceFile) {
    const normalizedSource = sourceFile.replace(/\\/g, '/');
    const match = Object.entries(files).find(([candidate]) => {
      const normalizedCandidate = candidate.replace(/\\/g, '/');
      return normalizedCandidate === normalizedSource || normalizedCandidate.endsWith(`/${normalizedSource}`) || normalizedSource.endsWith(`/${normalizedCandidate}`);
    });
    if (match) return { path: match[0], content: match[1] };
  }
  const javaFile = Object.entries(files).find(([candidate]) => candidate.toLowerCase().endsWith('.java'));
  return javaFile ? { path: javaFile[0], content: javaFile[1] } : undefined;
}

function findInlineLangContent(input: { langFileContent?: string; langYaml?: string; files?: Record<string, string>; supportFiles?: Record<string, string> }): string | undefined {
  if (input.langFileContent) return input.langFileContent;
  if (input.langYaml) return input.langYaml;
  const files = { ...(input.supportFiles ?? {}), ...(input.files ?? {}) };
  const match = Object.entries(files).find(([candidate]) => /(^|[/\\])lang\.ya?ml$/i.test(candidate));
  return match?.[1];
}

function buildGuiFromInput(input: {
  code?: string;
  matrix?: MatrixSpec;
  projectRoot?: string;
  sourceFile?: string;
  files?: Record<string, string>;
  supportFiles?: Record<string, string>;
  langFileContent?: string;
  langYaml?: string;
  className?: string;
  methodName?: string;
  entryMethod?: string;
  fixture?: string | Record<string, unknown>;
  fixtures?: Record<string, unknown>;
  mockParameters?: Record<string, unknown>;
}): { gui: GUIModel | null; notes: string[]; source?: string } {
  if (input.matrix) {
    return {
      gui: guiFromMatrixSpec(input.matrix),
      notes: ['Rendered from matrix specification.'],
    };
  }

  const inlineFiles = { ...(input.supportFiles ?? {}), ...(input.files ?? {}) };
  const inlineFile = findInlineFile(Object.keys(inlineFiles).length > 0 ? inlineFiles : undefined, input.sourceFile);
  const source = input.code ?? inlineFile?.content ?? (input.projectRoot && input.sourceFile ? readSourceFile(input.projectRoot, input.sourceFile) : undefined);

  if (source) {
    const fixturePreset = typeof input.fixture === 'string' ? loadFixturePreset(input.fixture, input.projectRoot) : undefined;
    const langContent = findInlineLangContent(input);
    const langFixture = langContent ? { lang: parseSimpleLangYaml(langContent) } : undefined;
    const fixtures = mergeFixtures(fixturePreset, langFixture, input.fixture, input.fixtures, input.mockParameters);
    const processed = applyFixtureSubstitutions(source, fixtures);
    const parsed = extractIFModel(processed);
    const notes: string[] = [];

    if (input.code) notes.push('Rendered from inline code.');
    else if (inlineFile) notes.push(`Rendered from inline file: ${inlineFile.path}`);
    else if (input.projectRoot && input.sourceFile) notes.push(`Loaded ${input.sourceFile} from ${path.resolve(input.projectRoot)}.`);

    if (typeof input.fixture === 'string') {
      notes.push(fixturePreset ? `Loaded fixture preset: ${input.fixture}` : `Fixture preset not found, using as hint only: ${input.fixture}`);
    }
    if (langContent) notes.push('Loaded inline lang.yml substitutions.');
    if (fixtures) notes.push('Applied fixture substitutions.');
    if (parsed.issues.length > 0) notes.push(`Parse hints: ${parsed.issues.length}`);
    if (input.className) notes.push(`Class hint: ${input.className}`);
    if (input.methodName || input.entryMethod) notes.push(`Entry method hint: ${input.methodName ?? input.entryMethod}`);
    return { gui: parsed.gui, notes, source: processed };
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
      inputSchema: {
        code: z.string().describe('Java source code containing IF GUI definitions'),
      },
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
      inputSchema: {
        ...renderCommonShape,
        code: z.string().optional().describe('Java source code containing IF GUI definitions'),
        matrix: renderMatrixSchema.optional().describe('Matrix-based GUI layout specification'),
      },
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
        const warnings = validateGUIModel(built.gui).filter((issue) => issue.severity !== 'error').map((issue) => issue.message);
        const metadata = {
          imagePath: meta.imagePath,
          title: meta.title,
          rows: meta.rows,
          columns: meta.columns,
          width: meta.width,
          height: meta.height,
          renderedItems: meta.renderedItems,
          unknownMaterials: meta.unknownMaterials,
          warnings,
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
      inputSchema: {
        ...projectGuiShape,
        ...renderCommonShape,
      },
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
      const warnings = validateGUIModel(built.gui).filter((issue) => issue.severity !== 'error').map((issue) => issue.message);
      const notes = [
        ...(built.notes.length > 0 ? built.notes : []),
        `Rendered ${meta.guiType} GUI "${meta.title}" (${meta.columns}x${meta.rows}) with ${meta.renderedItems} item(s).`,
        `Saved preview: ${meta.imagePath}`,
        meta.unknownMaterials.length > 0 ? `Unknown atlas materials: ${meta.unknownMaterials.join(', ')}` : undefined,
        warnings.length > 0 ? `Warnings: ${warnings.length}` : undefined,
      ].filter(Boolean).join('\n');
      const metadata = {
        imagePath: meta.imagePath,
        title: meta.title,
        rows: meta.rows,
        columns: meta.columns,
        width: meta.width,
        height: meta.height,
        renderedItems: meta.renderedItems,
        unknownMaterials: meta.unknownMaterials,
        warnings,
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
      inputSchema: {
        ...projectGuiShape,
        ...renderCommonShape,
        code: z.string().optional().describe('Java source code containing IF GUI definitions'),
        matrix: renderMatrixSchema.optional().describe('Matrix-based GUI layout specification'),
        x: z.number().int().describe('Slot column'),
        y: z.number().int().describe('Slot row'),
      },
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
      inputSchema: {
        code: z.string().describe('Java source code containing IF GUI definitions'),
      },
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
      inputSchema: {
        query: z.string().optional().describe('Optional prefix filter for item names'),
      },
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
      inputSchema: {
        topic: z.string().describe('Topic name, e.g. gui, panes, outline_pane, static_pane, gui_item, xml'),
      },
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
    return Boolean(winner && /close|back|exit|cancel/i.test(`${winner.item.displayName || ''} ${winner.item.material || ''}`));
  });
  if (!hasClose) {
    suggestions.push('- No close/back button detected. Users may find this bad UX; consider adding a close/back button.');
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
