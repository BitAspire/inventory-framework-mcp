import { GUIModel, PaneModel, ItemModel, ParsedResult, ValidationIssue } from './models.js';

type PaneType = 'OutlinePane' | 'StaticPane' | 'PaginatedPane' | 'PatternPane' | 'MasonryPane';

interface PanePlacement {
  x: number;
  y: number;
  positionSource: 'addPane';
}

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
  const guiCtor = findFirstConstructor(source, ['ChestGui', 'HopperGui', 'DropperGui', 'DispenserGui']);
  if (!guiCtor) return null;

  const guiClass = guiCtor.type;
  const guiType = guiClass.replace(/Gui$/, '').toLowerCase() as GUIModel['type'];
  const args = splitTopLevelArgs(guiCtor.args);

  let rows = defaultRowsForGui(guiType);
  let titleArg = args[0];

  if (guiType === 'chest') {
    if (/^-?\d+$/.test(args[0]?.trim() ?? '')) {
      rows = parseInt(args[0], 10);
      titleArg = args[1];
    }
  } else if (/^-?\d+$/.test(args[0]?.trim() ?? '')) {
    rows = parseInt(args[0], 10);
    titleArg = args[1];
  }

  let title = extractStringLiteral(titleArg ?? '') ?? 'Untitled';

  const titleSetter = source.match(/\.(setTitle|title)\s*\(\s*([^)]+)\)/);
  if (titleSetter) {
    const t = extractStringLiteral(titleSetter[2]);
    if (t) title = t;
  }

  const panes: PaneModel[] = [];
  const orphanItems: ItemModel[] = [];
  const paneRanges: Array<{ start: number; end: number }> = [];

  const paneDefs = findPaneDefinitions(source);
  for (const def of paneDefs) {
    const statementEnd = findPaneStatementEnd(source, def.varName, def.constructorEnd + 1);
    const statement = source.slice(def.statementStart, statementEnd);
    const items = extractItemsFromPaneStatement(statement, def.type, issues);
    const priorityInfo = extractPanePriority(statement);
    const placement = findPanePlacement(source, def.varName, def.constructorEnd + 1);
    const pane: PaneModel = {
      x: placement?.x ?? def.x,
      y: placement?.y ?? def.y,
      length: def.length,
      height: def.height,
      type: def.type,
      priority: priorityInfo.priority,
      priorityLabel: priorityInfo.priorityLabel,
      positionSource: placement?.positionSource ?? def.positionSource,
      declaredX: placement?.x ?? def.declaredX,
      declaredY: placement?.y ?? def.declaredY,
      visible: true,
      items,
    };
    panes.push(pane);
    paneRanges.push({ start: def.statementStart, end: statementEnd });
  }

  for (const inline of findInlinePanes(source)) {
    const statementEnd = findStatementEnd(source, inline.statementStart);
    const statement = source.slice(inline.statementStart, statementEnd);
    const items = extractItemsFromPaneStatement(statement, inline.type, issues);
    const priorityInfo = extractPanePriority(statement);
    const placement = findPanePlacementFromStatement(statement);
    panes.push({
      x: placement?.x ?? inline.x,
      y: placement?.y ?? inline.y,
      length: inline.length,
      height: inline.height,
      type: inline.type,
      priority: priorityInfo.priority,
      priorityLabel: priorityInfo.priorityLabel,
      positionSource: placement?.positionSource ?? inline.positionSource,
      declaredX: placement?.x ?? inline.declaredX,
      declaredY: placement?.y ?? inline.declaredY,
      visible: true,
      items,
    });
    paneRanges.push({ start: inline.statementStart, end: statementEnd });
  }

  const orphanItemRegex = /new\s+GuiItem\s*\(\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
  let m: RegExpExecArray | null;
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

function findFirstConstructor(source: string, types: string[]): { type: string; start: number; end: number; args: string } | null {
  const pattern = new RegExp(`\\bnew\\s+(${types.join('|')})\\s*\\(`, 'g');
  const match = pattern.exec(source);
  if (!match) return null;
  const openParen = match.index + match[0].length - 1;
  const end = findMatchingParen(source, openParen);
  if (end < 0) return null;
  return {
    type: match[1]!,
    start: match.index,
    end,
    args: source.slice(openParen + 1, end),
  };
}

interface PaneDefinition {
  type: PaneType;
  varName: string;
  statementStart: number;
  constructorEnd: number;
  x: number;
  y: number;
  length: number;
  height: number;
  positionSource: 'constructor' | 'default';
  declaredX?: number;
  declaredY?: number;
}

function findPaneDefinitions(source: string): PaneDefinition[] {
  const defs: PaneDefinition[] = [];
  const pattern = /\b(OutlinePane|StaticPane|PaginatedPane|PatternPane|MasonryPane)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*new\s+\1\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    const type = m[1] as PaneType;
    const varName = m[2];
    const openParen = m.index + m[0].length - 1;
    const constructorEnd = findMatchingParen(source, openParen);
    if (constructorEnd < 0) continue;

    const args = splitTopLevelArgs(source.slice(openParen + 1, constructorEnd));
    const parsed = interpretPaneConstructor(args);
    defs.push({
      type,
      varName,
      statementStart: m.index,
      constructorEnd,
      ...parsed,
    });
  }
  return defs;
}

function findInlinePanes(source: string): PaneDefinition[] {
  const defs: PaneDefinition[] = [];
  const pattern = /\b(OutlinePane|StaticPane|PaginatedPane|PatternPane|MasonryPane)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*new\s+\1\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    // Handled by findPaneDefinitions; kept here for parity if constructor parsing changes later.
    continue;
  }

  const inlinePattern = /\.addPane\s*\(\s*new\s+(OutlinePane|StaticPane|PaginatedPane|PatternPane|MasonryPane)\s*\(/g;
  while ((m = inlinePattern.exec(source)) !== null) {
    const type = m[1] as PaneType;
    const openParen = m.index + m[0].lastIndexOf('(');
    const constructorEnd = findMatchingParen(source, openParen);
    if (constructorEnd < 0) continue;
    const args = splitTopLevelArgs(source.slice(openParen + 1, constructorEnd));
    const parsed = interpretPaneConstructor(args);
    defs.push({
      type,
      varName: '',
      statementStart: m.index,
      constructorEnd,
      ...parsed,
    });
  }

  return defs;
}

function findPaneStatementEnd(source: string, varName: string, afterIndex: number): number {
  if (varName) {
    const search = source.slice(afterIndex);
    const safeVar = escapeRegex(varName);
    const addPaneMatch = search.match(new RegExp(`\\.addPane\\s*\\([^;]*\\b${safeVar}\\b[^;]*\\)\\s*;`, 'm'));
    if (addPaneMatch && addPaneMatch.index !== undefined) {
      return afterIndex + addPaneMatch.index + addPaneMatch[0].length;
    }
  }

  return findStatementEnd(source, afterIndex);
}

function interpretPaneConstructor(args: string[]): Omit<PaneDefinition, 'type' | 'varName' | 'statementStart' | 'constructorEnd'> {
  const numbers = args.map((arg) => parseInteger(arg));

  if (numbers.length >= 4 && numbers.slice(0, 4).every((n) => n !== null)) {
    return {
      x: numbers[0]!,
      y: numbers[1]!,
      length: Math.max(1, numbers[2]!),
      height: Math.max(1, numbers[3]!),
      positionSource: 'constructor',
      declaredX: numbers[0]!,
      declaredY: numbers[1]!,
    };
  }

  if (numbers.length >= 2 && numbers[0] !== null && numbers[1] !== null) {
    return {
      x: 0,
      y: 0,
      length: Math.max(1, numbers[0]!),
      height: Math.max(1, numbers[1]!),
      positionSource: 'default',
    };
  }

  if (numbers.length === 1 && numbers[0] !== null) {
    return {
      x: 0,
      y: 0,
      length: Math.max(1, numbers[0]!),
      height: 1,
      positionSource: 'default',
    };
  }

  return {
    x: 0,
    y: 0,
    length: 1,
    height: 1,
    positionSource: 'default',
  };
}

function findPanePlacement(source: string, varName: string, afterIndex: number): PanePlacement | null {
  if (!varName) return null;
  const safeVar = escapeRegex(varName);
  const search = source.slice(afterIndex);

  const slotMatch = search.match(new RegExp(`\\.addPane\\s*\\(\\s*Slot\\.fromXY\\s*\\(\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\)\\s*,\\s*${safeVar}\\s*\\)`));
  if (slotMatch) {
    return { x: parseInt(slotMatch[1]!, 10), y: parseInt(slotMatch[2]!, 10), positionSource: 'addPane' };
  }

  const xyMatch = search.match(new RegExp(`\\.addPane\\s*\\(\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*,\\s*${safeVar}\\s*\\)`));
  if (xyMatch) {
    return { x: parseInt(xyMatch[1]!, 10), y: parseInt(xyMatch[2]!, 10), positionSource: 'addPane' };
  }

  const simpleMatch = search.match(new RegExp(`\\.addPane\\s*\\(\\s*${safeVar}\\s*\\)`));
  if (simpleMatch) {
    return null;
  }

  return null;
}

function findPanePlacementFromStatement(statement: string): PanePlacement | null {
  const slotMatch = statement.match(/\.addPane\s*\(\s*Slot\.fromXY\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*,\s*new\s+(?:OutlinePane|StaticPane|PaginatedPane|PatternPane|MasonryPane)\s*\(/);
  if (slotMatch) {
    return { x: parseInt(slotMatch[1]!, 10), y: parseInt(slotMatch[2]!, 10), positionSource: 'addPane' };
  }

  const xyMatch = statement.match(/\.addPane\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*new\s+(?:OutlinePane|StaticPane|PaginatedPane|PatternPane|MasonryPane)\s*\(/);
  if (xyMatch) {
    return { x: parseInt(xyMatch[1]!, 10), y: parseInt(xyMatch[2]!, 10), positionSource: 'addPane' };
  }

  return null;
}

function extractPanePriority(statement: string): { priority: number; priorityLabel?: string } {
  const priorityMatch = statement.match(/\.(?:set)?priority\s*\(\s*(?:Pane\.)?(?:Priority\.)?([A-Z_]+)\s*\)/i);
  if (priorityMatch) {
    const label = priorityMatch[1]!.toUpperCase();
    return { priority: priorityRank(label), priorityLabel: label };
  }

  const numericMatch = statement.match(/\.(?:set)?priority\s*\(\s*(-?\d+)\s*\)/i);
  if (numericMatch) {
    return { priority: parseInt(numericMatch[1]!, 10) };
  }

  return { priority: 0 };
}

function priorityRank(label: string): number {
  if (label === 'LOWEST') return -300;
  if (label === 'LOW') return -150;
  if (label === 'NORMAL') return 0;
  if (label === 'HIGH') return 150;
  if (label === 'HIGHEST') return 300;
  return 0;
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

function findMatchingParen(source: string, openParenIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openParenIndex; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findStatementEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) return i + 1;
  }
  return source.length;
}

function extractItemsFromPaneStatement(statement: string, paneType: PaneType, issues: ValidationIssue[]): ItemModel[] {
  const items: ItemModel[] = [];
  if (paneType === 'StaticPane') {
    const bindRegex = /\.bindItem\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
    let bm: RegExpExecArray | null;
    while ((bm = bindRegex.exec(statement)) !== null) {
      const item = extractGuiItem(bm[3], issues);
      if (item) {
        item.slotX = parseInt(bm[1]!, 10);
        item.slotY = parseInt(bm[2]!, 10);
        items.push(item);
      }
    }
  } else {
    const addItemRegex = /\.addItem\s*\(\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
    let im: RegExpExecArray | null;
    while ((im = addItemRegex.exec(statement)) !== null) {
      const item = extractGuiItem(im[1], issues);
      if (item) items.push(item);
    }
  }
  return items;
}

function extractGuiItem(expr: string, issues: ValidationIssue[]): ItemModel | null {
  expr = expr.trim();
  if (!expr) return null;

  let material = 'STONE';
  let amount = 1;
  let displayName: string | undefined;
  let lore: string[] | undefined;
  let enchanted = false;
  let customModelData: number | undefined;
  let hasClickHandler = false;

  const matMatch = expr.match(/Material\.([A-Z_]+)/);
  if (matMatch) material = matMatch[1]!;

  const amountMatch = expr.match(/new\s+ItemStack\s*\(\s*Material\.\w+\s*,\s*(\d+)\)/);
  if (amountMatch) amount = parseInt(amountMatch[1]!, 10);

  const dnSetter = expr.match(/setDisplayName\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/);
  if (dnSetter) displayName = unescapeJavaString(dnSetter[1]!);

  const loreSetter = expr.match(/setLore\s*\(\s*(?:Arrays\.asList\s*\()?\s*([^)]*)\s*\)?\)/);
  if (loreSetter) {
    lore = extractStringArray(loreSetter[1]!);
  }

  if (/addEnchantment|addUnsafeEnchantment|glow\s*\(\s*true\s*\)/.test(expr)) {
    enchanted = true;
  }

  const cmdMatch = expr.match(/setCustomModelData\s*\(\s*(\d+)\s*\)/);
  if (cmdMatch) customModelData = parseInt(cmdMatch[1]!, 10);

  if (/->|setClickAction\s*\(|setAction\s*\(/.test(expr)) {
    hasClickHandler = true;
  }

  if (!material || material === 'UNKNOWN') {
    issues.push({
      ruleId: 'unknown-material',
      severity: 'error',
      message: 'Item has no valid Material specified.',
      location: displayName || 'Unnamed item',
    });
    return null;
  }

  return { material, amount, displayName, lore, enchanted, customModelData, hasClickHandler };
}

function extractStringLiteral(raw: string): string | null {
  raw = raw.trim();
  const m = raw.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) return unescapeJavaString(m[1]!);
  return null;
}

function extractStringArray(raw: string): string[] {
  const result: string[] = [];
  const regex = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    result.push(unescapeJavaString(m[1]!));
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

function parseInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
