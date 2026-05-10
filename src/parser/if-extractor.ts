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
  const guiMatch = source.match(/new\s+(ChestGui|HopperGui|DropperGui|DispenserGui)\s*\(\s*(\d+)\s*,\s*([^)]+)\)/);
  if (!guiMatch) return null;

  const guiType = guiMatch[1].toLowerCase() as GUIModel['type'];
  const rows = parseInt(guiMatch[2], 10);
  let title = extractStringLiteral(guiMatch[3]) ?? 'Untitled';

  // Override title if setTitle is called
  const titleSetter = source.match(/\.(setTitle|title)\s*\(\s*([^)]+)\)/);
  if (titleSetter) {
    const t = extractStringLiteral(titleSetter[2]);
    if (t) title = t;
  }

  const panes: PaneModel[] = [];
  const orphanItems: ItemModel[] = [];

  // Find all addPane(...) calls
  const addPaneRegex = /\.addPane\s*\(\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = addPaneRegex.exec(source)) !== null) {
    const paneExpr = m[1];
    const pane = extractPane(paneExpr, issues);
    if (pane) panes.push(pane);
  }

  // Find orphan GuiItems added directly to GUI (not in pane)
  const orphanItemRegex = /new\s+GuiItem\s*\(\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
  while ((m = orphanItemRegex.exec(source)) !== null) {
    const item = extractGuiItem(m[1], issues);
    if (item) orphanItems.push(item);
  }

  return { type: guiType, rows, title, panes, orphanItems };
}

function extractPane(expr: string, issues: ValidationIssue[]): PaneModel | null {
  // e.g. new OutlinePane(0, 0, 9, 1) or new StaticPane(1, 1, 7, 4)
  const paneCtor = expr.match(/new\s+(OutlinePane|StaticPane|PaginatedPane|PatternPane|MasonryPane)\s*\(\s*([\d\s,]+)\)/);
  if (!paneCtor) {
    // Try to infer if variable reference – skip for now
    return null;
  }

  const paneType = paneCtor[1];
  const nums = paneCtor[2].split(',').map((s) => parseInt(s.trim(), 10));
  const [x = 0, y = 0, length = 1, height = 1] = nums;

  const items: ItemModel[] = [];

  // OutlinePane: addItem(GuiItem) repeated
  // StaticPane: bindItem(slotX, slotY, GuiItem)
  if (paneType === 'StaticPane') {
    const bindRegex = /\.bindItem\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
    let bm: RegExpExecArray | null;
    while ((bm = bindRegex.exec(expr)) !== null) {
      const item = extractGuiItem(bm[3], issues);
      if (item) {
        item.slotX = parseInt(bm[1], 10);
        item.slotY = parseInt(bm[2], 10);
        items.push(item);
      }
    }
  } else {
    // General addItem for OutlinePane / PaginatedPane / others
    const itemRegex = /\.addItem\s*\(\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
    let im: RegExpExecArray | null;
    while ((im = itemRegex.exec(expr)) !== null) {
      const item = extractGuiItem(im[1], issues);
      if (item) items.push(item);
    }
  }

  // Also look for inline GuiItem constructions inside the pane expression itself
  // (some users do addItem(new GuiItem(...)) inside the same line as pane constructor)
  const orphanInPane = /new\s+GuiItem\s*\(\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/g;
  let om: RegExpExecArray | null;
  while ((om = orphanInPane.exec(expr)) !== null) {
    const item = extractGuiItem(om[1], issues);
    if (item && !items.find((i) => i.material === item.material && i.displayName === item.displayName)) {
      items.push(item);
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

function extractGuiItem(expr: string, issues: ValidationIssue[]): ItemModel | null {
  // Remove surrounding whitespace
  expr = expr.trim();

  // Case 1: new GuiItem(new ItemStack(Material.XXX, amount))
  // Case 2: new GuiItem(new ItemStackBuilder(Material.XXX).setDisplayName(...)...build())
  // Case 3: new GuiItem(Material.XXX)

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
