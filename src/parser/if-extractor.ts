import { GUIModel, PaneModel, ItemModel, ParsedResult, ValidationIssue } from './models.js';

export function extractIFModel(source: string): ParsedResult {
  const issues: ValidationIssue[] = [];
  const gui = extractGui(source, issues);
  if (!gui) {
    issues.push({
      ruleId: 'no-gui-found',
      severity: 'error',
      message: 'No recognized GUI constructor found (e.g., new ChestGui(...)).',
    });
  }
  return { gui, issues };
}

function extractGui(source: string, issues: ValidationIssue[]): GUIModel | null {
  // Detect GUI type and basic properties
  const guiMatch = source.match(/new\s+(ChestGui|HopperGui|DropperGui|DispenserGui)\s*\(\s*([^)]*)\)/);
  if (!guiMatch) return null;

  const guiClass = guiMatch[1];
  const guiType = guiClass.replace(/Gui$/, '').toLowerCase() as GUIModel['type'];
  const args = splitTopLevelArgs(guiMatch[2]);
  let rows = defaultRowsForGui(guiType);
  let titleArg = args[0];

  if (guiType === 'chest' && /^\d+$/.test(args[0]?.trim() ?? '')) {
    rows = parseInt(args[0], 10);
    titleArg = args[1];
  } else if (/^\d+$/.test(args[0]?.trim() ?? '')) {
    rows = parseInt(args[0], 10);
    titleArg = args[1];
  }

  let title = extractStringLiteral(titleArg ?? '') ?? 'Untitled';

  // Override title if setTitle is called
  const titleSetter = source.match(/\.(setTitle|title)\s*\(\s*([^)]+)\)/);
  if (titleSetter) {
    const t = extractStringLiteral(titleSetter[2]);
    if (t) title = t;
  }

  const panes: PaneModel[] = [];
  const orphanItems: ItemModel[] = [];

  // Find pane variable definitions
  const paneDefRegex = /\b(OutlinePane|StaticPane|PaginatedPane|PatternPane|MasonryPane)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*new\s+(OutlinePane|StaticPane|PaginatedPane|PatternPane|MasonryPane)\s*\(\s*([\d\s,]+)\)/g;
  const paneBlocks = new Map<string, { type: string; x: number; y: number; length: number; height: number; code: string }>();
  const paneRanges: Array<{ start: number; end: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = paneDefRegex.exec(source)) !== null) {
    const type = m[1];
    const varName = m[2];
    const nums = m[4].split(',').map((s) => parseInt(s.trim(), 10));
    const [x = 0, y = 0, length = 1, height = 1] = nums;

    // Extract block of code between definition and gui.addPane(varName)
    const startIdx = m.index + m[0].length;
    const addPanePos = source.indexOf(`gui.addPane(${varName})`, startIdx);
    const blockEnd = addPanePos > 0 ? addPanePos : source.indexOf(';', startIdx) + 1;
    const code = source.substring(startIdx, blockEnd);

    paneBlocks.set(varName, { type, x, y, length, height, code });
    paneRanges.push({ start: m.index, end: blockEnd });
  }

  // Process each pane block
  for (const [varName, block] of paneBlocks) {
    const pane = buildPaneFromBlock(block.type, block.x, block.y, block.length, block.height, block.code, varName, issues);
    panes.push(pane);
  }

  // Find inline addPane(new Pane(...)) – items usually empty for this pattern
  const inlineAddPane = /\.addPane\s*\(\s*new\s+(OutlinePane|StaticPane|PaginatedPane|PatternPane|MasonryPane)\s*\(\s*([\d\s,]+)\)\s*\)/g;
  while ((m = inlineAddPane.exec(source)) !== null) {
    const type = m[1];
    const nums = m[2].split(',').map((s) => parseInt(s.trim(), 10));
    const [x = 0, y = 0, length = 1, height = 1] = nums;
    // Attempt to find chained method calls in same statement
    const stmtStart = m.index;
    const stmtEnd = findStatementEnd(source, stmtStart);
    const stmt = source.substring(stmtStart, stmtEnd);
    const items = extractItemsFromPaneStatement(stmt, type, issues);
    panes.push({ x, y, length, height, type, priority: 0, visible: true, items });
    paneRanges.push({ start: stmtStart, end: stmtEnd });
  }

  // Find orphan GuiItems added directly to GUI (not in pane)
  const orphanItemRegex = /new\s+GuiItem\s*\(\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
  while ((m = orphanItemRegex.exec(source)) !== null) {
    const inPane = paneRanges.some((r) => m!.index >= r.start && m!.index < r.end);
    if (inPane) continue;
    const item = extractGuiItem(m[1], issues);
    if (item) orphanItems.push(item);
  }

  return { type: guiType, rows, title, panes, orphanItems };
}

function defaultRowsForGui(type: GUIModel['type']): number {
  if (type === 'hopper') return 1;
  if (type === 'dropper' || type === 'dispenser') return 3;
  return 1;
}

function splitTopLevelArgs(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const ch of raw) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (!inString) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }

  if (current.trim()) args.push(current.trim());
  return args;
}

function buildPaneFromBlock(
  paneType: string,
  x: number,
  y: number,
  length: number,
  height: number,
  code: string,
  varName: string,
  issues: ValidationIssue[]
): PaneModel {
  const items: ItemModel[] = [];

  // Escape varName for regex
  const safeVar = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (paneType === 'StaticPane') {
    const bindRegex = new RegExp(`${safeVar}\\.bindItem\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*([^)]+(?:\\([^)]*\\)[^)]*)*)\\)`, 'g');
    let bm: RegExpExecArray | null;
    while ((bm = bindRegex.exec(code)) !== null) {
      const item = extractGuiItem(bm[3], issues);
      if (item) {
        item.slotX = parseInt(bm[1], 10);
        item.slotY = parseInt(bm[2], 10);
        items.push(item);
      }
    }
  } else {
    const addItemRegex = new RegExp(`${safeVar}\\.addItem\\s*\\(\\s*([^)]+(?:\\([^)]*\\)[^)]*)*)\\)`, 'g');
    let im: RegExpExecArray | null;
    while ((im = addItemRegex.exec(code)) !== null) {
      const item = extractGuiItem(im[1], issues);
      if (item) items.push(item);
    }
  }

  return {
    x, y, length, height,
    type: paneType,
    priority: 0,
    visible: true,
    items,
  };
}

function extractItemsFromPaneStatement(stmt: string, paneType: string, issues: ValidationIssue[]): ItemModel[] {
  const items: ItemModel[] = [];
  if (paneType === 'StaticPane') {
    const bindRegex = /\.bindItem\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
    let bm: RegExpExecArray | null;
    while ((bm = bindRegex.exec(stmt)) !== null) {
      const item = extractGuiItem(bm[3], issues);
      if (item) {
        item.slotX = parseInt(bm[1], 10);
        item.slotY = parseInt(bm[2], 10);
        items.push(item);
      }
    }
  } else {
    const addItemRegex = /\.addItem\s*\(\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
    let im: RegExpExecArray | null;
    while ((im = addItemRegex.exec(stmt)) !== null) {
      const item = extractGuiItem(im[1], issues);
      if (item) items.push(item);
    }
  }
  return items;
}

function findStatementEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth <= 0) return i + 1;
  }
  return source.length;
}

function extractGuiItem(expr: string, issues: ValidationIssue[]): ItemModel | null {
  expr = expr.trim();

  let material = 'STONE';
  let amount = 1;
  let displayName: string | undefined;
  let lore: string[] | undefined;
  let enchanted = false;
  let customModelData: number | undefined;

  const matMatch = expr.match(/Material\.([A-Z_]+)/);
  if (matMatch) material = matMatch[1];

  const amountMatch = expr.match(/new\s+ItemStack\s*\(\s*Material\.\w+\s*,\s*(\d+)\)/);
  if (amountMatch) amount = parseInt(amountMatch[1], 10);

  const dnSetter = expr.match(/setDisplayName\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/);
  if (dnSetter) displayName = unescapeJavaString(dnSetter[1]);

  const loreSetter = expr.match(/setLore\s*\(\s*(?:Arrays\.asList\s*\()?\s*([^)]*)\s*\)?\)/);
  if (loreSetter) {
    lore = extractStringArray(loreSetter[1]);
  }

  if (/addEnchantment|addUnsafeEnchantment|glow\s*\(\s*true\s*\)/.test(expr)) {
    enchanted = true;
  }

  const cmdMatch = expr.match(/setCustomModelData\s*\(\s*(\d+)\s*\)/);
  if (cmdMatch) customModelData = parseInt(cmdMatch[1], 10);

  return { material, amount, displayName, lore, enchanted, customModelData };
}

function extractStringLiteral(raw: string): string | null {
  raw = raw.trim();
  const m = raw.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) return unescapeJavaString(m[1]);
  return null;
}

function extractStringArray(raw: string): string[] {
  const result: string[] = [];
  const regex = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    result.push(unescapeJavaString(m[1]));
  }
  return result;
}

function unescapeJavaString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
