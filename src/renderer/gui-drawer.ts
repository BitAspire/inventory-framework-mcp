import { Jimp } from 'jimp';
import * as fs from 'fs';
import * as path from 'path';
import { GUIModel, ItemModel, PaneModel } from '../parser/models.js';
import { getAtlasEntry, getFallbackColor } from './item-atlas.js';

const SLOT_SIZE_BASE = 32;
const GAP_BASE = 2;
const PADDING_BASE = 16;
const TITLE_BAR_BASE = 20;
const MODULE_DIR = __dirname;

export interface RenderOptions {
  scale?: number;
  texturePath?: string;
}

export interface RenderResult {
  base64: string;
  metadata: {
    title: string;
    guiType: GUIModel['type'];
    columns: number;
    rows: number;
    renderedItems: number;
    texturedItems: number;
    fallbackItems: string[];
    unknownMaterials: string[];
  };
}

interface SlotItem {
  item: ItemModel;
  col: number;
  row: number;
}

const textureCache = new Map<string, any | null>();

export async function renderGUIBase64(gui: GUIModel, scale = 2): Promise<string> {
  return (await renderGUI(gui, { scale })).base64;
}

export async function renderGUI(gui: GUIModel, options: RenderOptions = {}): Promise<RenderResult> {
  const scale = options.scale ?? 2;
  const slotSize = SLOT_SIZE_BASE * scale;
  const gap = GAP_BASE * scale;
  const padding = PADDING_BASE * scale;
  const titleBar = TITLE_BAR_BASE * scale;

  const cols = columnsForGui(gui);
  const rows = rowsForGui(gui);

  const width = padding * 2 + cols * slotSize + (cols - 1) * gap;
  const height = padding * 2 + titleBar + rows * slotSize + (rows - 1) * gap;

  const image = new Jimp({ width, height, color: 0xC6C6C6FF });

  drawWindow(image, width, height, padding, titleBar);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const { x, y } = slotToPixels(c, r, padding, titleBar, slotSize, gap);
      drawSlot(image, x, y, slotSize);
    }
  }

  for (const pane of gui.panes) {
    drawPane(image, pane, padding, titleBar, slotSize, gap, scale);
  }

  const slotItems = resolveSlotItems(gui, cols, rows);
  const fallbackItems = new Set<string>();
  const unknownMaterials = new Set<string>();
  let texturedItems = 0;

  for (const slotItem of slotItems) {
    if (!getAtlasEntry(slotItem.item.material)) unknownMaterials.add(slotItem.item.material);
    const usedTexture = await drawItem(image, slotItem, padding, titleBar, slotSize, gap, scale, options.texturePath);
    if (usedTexture) texturedItems++;
    else fallbackItems.add(slotItem.item.material);
  }

  const buf = await image.getBuffer('image/png');
  return {
    base64: buf.toString('base64'),
    metadata: {
      title: gui.title,
      guiType: gui.type,
      columns: cols,
      rows,
      renderedItems: slotItems.length,
      texturedItems,
      fallbackItems: [...fallbackItems].sort(),
      unknownMaterials: [...unknownMaterials].sort(),
    },
  };
}

function columnsForGui(gui: GUIModel): number {
  if (gui.type === 'hopper') return 5;
  if (gui.type === 'dropper' || gui.type === 'dispenser') return 3;
  return 9;
}

function rowsForGui(gui: GUIModel): number {
  if (gui.type === 'hopper') return 1;
  if (gui.type === 'dropper' || gui.type === 'dispenser') return 3;
  return gui.rows;
}

function drawWindow(img: any, width: number, height: number, padding: number, titleBar: number) {
  drawRect(img, 0, 0, width, height, 0x373737FF);
  drawRect(img, 1, 1, width - 2, height - 2, 0xFFFFFFFF);
  drawRect(img, 2, 2, width - 4, height - 4, 0xC6C6C6FF);
  drawRect(img, padding, padding, width - padding * 2, titleBar, 0x8B8B8BFF);
  drawRect(img, padding, padding, width - padding * 2, 1, 0xFFFFFFFF);
  drawRect(img, padding, padding + titleBar - 1, width - padding * 2, 1, 0x555555FF);
}

function resolveSlotItems(gui: GUIModel, cols: number, rows: number): SlotItem[] {
  const result: SlotItem[] = [];

  for (const item of gui.orphanItems) {
    result.push({
      item,
      col: clamp(item.slotX ?? 0, 0, cols - 1),
      row: clamp(item.slotY ?? 0, 0, rows - 1),
    });
  }

  for (const pane of gui.panes) {
    pane.items.forEach((item, index) => {
      const local = resolvePaneItemPosition(pane, item, index);
      const col = pane.x + local.col;
      const row = pane.y + local.row;
      if (col >= 0 && row >= 0 && col < cols && row < rows) {
        result.push({ item, col, row });
      }
    });
  }

  return result;
}

function resolvePaneItemPosition(pane: PaneModel, item: ItemModel, index: number): { col: number; row: number } {
  if (item.slotX !== undefined && item.slotY !== undefined) {
    return { col: item.slotX, row: item.slotY };
  }

  if (pane.type === 'OutlinePane') {
    const outlineSlots = outlinePositions(pane.length, pane.height);
    return outlineSlots[index % outlineSlots.length] ?? { col: 0, row: 0 };
  }

  const width = Math.max(1, pane.length);
  return { col: index % width, row: Math.floor(index / width) };
}

function outlinePositions(width: number, height: number): Array<{ col: number; row: number }> {
  const positions: Array<{ col: number; row: number }> = [];
  for (let col = 0; col < width; col++) positions.push({ col, row: 0 });
  for (let row = 1; row < height; row++) positions.push({ col: width - 1, row });
  if (height > 1) {
    for (let col = width - 2; col >= 0; col--) positions.push({ col, row: height - 1 });
  }
  if (width > 1) {
    for (let row = height - 2; row > 0; row--) positions.push({ col: 0, row });
  }
  return positions;
}

function drawRect(img: any, x: number, y: number, w: number, h: number, color: number) {
  const startX = Math.round(x);
  const startY = Math.round(y);
  const width = Math.max(0, Math.round(w));
  const height = Math.max(0, Math.round(h));

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const px = startX + dx;
      const py = startY + dy;
      if (px >= 0 && py >= 0 && px < img.bitmap.width && py < img.bitmap.height) {
        img.setPixelColor(color, px, py);
      }
    }
  }
}

function drawLine(img: any, x1: number, y1: number, x2: number, y2: number, thickness: number, color: number) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  if (steps === 0) {
    drawRect(img, x1, y1, thickness, thickness, color);
    return;
  }
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x1 + ((x2 - x1) * i) / steps);
    const y = Math.round(y1 + ((y2 - y1) * i) / steps);
    drawRect(img, x, y, thickness, thickness, color);
  }
}

function drawSlot(img: any, x: number, y: number, size: number) {
  drawRect(img, x + 1, y + 1, size - 1, size - 1, 0x373737FF);
  drawRect(img, x, y, size - 1, size - 1, 0xFFFFFFFF);
  drawRect(img, x + 1, y + 1, size - 2, size - 2, 0x8B8B8BFF);
  drawRect(img, x + 2, y + 2, size - 4, size - 4, 0x777777FF);
}

function drawPane(img: any, pane: PaneModel, padding: number, titleBar: number, slotSize: number, gap: number, scale: number) {
  const x = padding + pane.x * (slotSize + gap);
  const y = padding + titleBar + pane.y * (slotSize + gap);
  const w = pane.length * (slotSize + gap) - gap;
  const h = pane.height * (slotSize + gap) - gap;
  const thickness = Math.max(1, scale);

  if (pane.type === 'OutlinePane') {
    drawRect(img, x, y, w, thickness, 0x4F4F4FFF);
    drawRect(img, x, y + h - thickness, w, thickness, 0x4F4F4FFF);
    drawRect(img, x, y, thickness, h, 0x4F4F4FFF);
    drawRect(img, x + w - thickness, y, thickness, h, 0x4F4F4FFF);
  } else if (pane.type === 'PaginatedPane') {
    drawRect(img, x, y, w, thickness, 0x5B6E8DFF);
    drawRect(img, x, y + h - thickness, w, thickness, 0x5B6E8DFF);
  }
}

async function drawItem(
  img: any,
  slotItem: SlotItem,
  padding: number,
  titleBar: number,
  slotSize: number,
  gap: number,
  scale: number,
  texturePath?: string
): Promise<boolean> {
  const { item, col, row } = slotItem;
  const { x, y } = slotToPixels(col, row, padding, titleBar, slotSize, gap);
  const iconMargin = Math.max(4, 4 * scale);
  const iconSize = slotSize - iconMargin * 2;
  const iconX = x + iconMargin;
  const iconY = y + iconMargin;

  const texture = await loadTexture(item.material, texturePath);
  if (texture) {
    const resized = texture.clone().resize({ w: iconSize, h: iconSize });
    img.composite(resized, iconX, iconY);
  } else {
    drawFallbackIcon(img, item, iconX, iconY, iconSize, scale);
  }

  if (item.enchanted) drawGlint(img, iconX, iconY, iconSize, scale);
  if (item.customModelData !== undefined) drawRect(img, x + slotSize - 7 * scale, y + 2 * scale, 5 * scale, 5 * scale, 0x4AA3FFFF);
  if (item.amount && item.amount > 1) drawStackBadge(img, x, y, slotSize, scale);

  return Boolean(texture);
}

function drawFallbackIcon(img: any, item: ItemModel, x: number, y: number, size: number, scale: number) {
  const base = hexToJimpColor(getFallbackColor(item.material));
  const dark = shadeColor(base, -45);
  const light = shadeColor(base, 35);
  const material = item.material.toUpperCase();

  if (material.includes('SWORD')) {
    drawLine(img, x + size * 0.25, y + size * 0.78, x + size * 0.78, y + size * 0.25, Math.max(2, 2 * scale), light);
    drawRect(img, x + size * 0.18, y + size * 0.78, size * 0.38, Math.max(2, 3 * scale), dark);
    drawRect(img, x + size * 0.18, y + size * 0.84, size * 0.18, Math.max(2, 3 * scale), 0x6A442AFF);
    return;
  }

  if (material.includes('PICKAXE') || material.includes('AXE')) {
    drawLine(img, x + size * 0.35, y + size * 0.28, x + size * 0.72, y + size * 0.65, Math.max(2, 2 * scale), 0x6A442AFF);
    drawRect(img, x + size * 0.18, y + size * 0.2, size * 0.55, Math.max(3, 4 * scale), light);
    drawRect(img, x + size * 0.18, y + size * 0.2, Math.max(3, 4 * scale), size * 0.22, dark);
    return;
  }

  if (material.includes('APPLE') || material.includes('BERRY')) {
    drawDiamond(img, x + size * 0.15, y + size * 0.18, size * 0.7, base, dark, light);
    drawRect(img, x + size * 0.52, y + size * 0.08, Math.max(2, 2 * scale), size * 0.16, 0x5D3A1AFF);
    return;
  }

  if (material.includes('POTION') || material.includes('BOTTLE')) {
    drawRect(img, x + size * 0.38, y + size * 0.12, size * 0.24, size * 0.22, 0xD0E8F2AA);
    drawRect(img, x + size * 0.25, y + size * 0.34, size * 0.5, size * 0.5, base);
    drawRect(img, x + size * 0.31, y + size * 0.42, size * 0.38, size * 0.18, light);
    return;
  }

  if (material.includes('HEAD') || material.includes('SKULL')) {
    drawRect(img, x + size * 0.18, y + size * 0.16, size * 0.64, size * 0.64, base);
    drawRect(img, x + size * 0.28, y + size * 0.35, size * 0.12, size * 0.12, dark);
    drawRect(img, x + size * 0.6, y + size * 0.35, size * 0.12, size * 0.12, dark);
    drawRect(img, x + size * 0.38, y + size * 0.62, size * 0.24, Math.max(2, 2 * scale), dark);
    return;
  }

  if (getAtlasEntry(material)?.category === 'blocks' || material.endsWith('_BLOCK')) {
    drawBlock(img, x, y, size, base, dark, light);
    return;
  }

  drawDiamond(img, x + size * 0.12, y + size * 0.12, size * 0.76, base, dark, light);
}

function drawBlock(img: any, x: number, y: number, size: number, base: number, dark: number, light: number) {
  drawRect(img, x + size * 0.18, y + size * 0.18, size * 0.62, size * 0.62, base);
  drawRect(img, x + size * 0.18, y + size * 0.18, size * 0.62, size * 0.12, light);
  drawRect(img, x + size * 0.68, y + size * 0.18, size * 0.12, size * 0.62, dark);
  drawRect(img, x + size * 0.18, y + size * 0.68, size * 0.62, size * 0.12, dark);
}

function drawDiamond(img: any, x: number, y: number, size: number, base: number, dark: number, light: number) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  for (let row = 0; row < size; row++) {
    const halfWidth = (size / 2) - Math.abs(row - size / 2);
    drawRect(img, cx - halfWidth, y + row, halfWidth * 2, 1, base);
  }
  drawLine(img, x + size * 0.5, y, x + size, y + size * 0.5, 1, light);
  drawLine(img, x, y + size * 0.5, x + size * 0.5, y + size, 1, dark);
  drawLine(img, x + size, y + size * 0.5, x + size * 0.5, y + size, 1, dark);
}

function drawGlint(img: any, x: number, y: number, size: number, scale: number) {
  const thickness = Math.max(1, scale);
  for (let offset = -size; offset < size * 2; offset += 8 * scale) {
    drawLine(img, x + offset, y + size, x + offset + size, y, thickness, 0xB66DFFFF);
  }
}

function drawStackBadge(img: any, x: number, y: number, slotSize: number, scale: number) {
  const w = 10 * scale;
  const h = 6 * scale;
  drawRect(img, x + slotSize - w - 2 * scale, y + slotSize - h - 2 * scale, w, h, 0x1A1A1AE0);
  drawRect(img, x + slotSize - w, y + slotSize - h, w - 3 * scale, Math.max(1, scale), 0xFFFFFFFF);
  drawRect(img, x + slotSize - w, y + slotSize - h + 2 * scale, w - 5 * scale, Math.max(1, scale), 0xFFFFFFFF);
}

async function loadTexture(material: string, texturePath?: string): Promise<any | null> {
  const textureRoots = getTextureRoots(texturePath);
  if (textureRoots.length === 0) return null;

  const normalized = material.toLowerCase();
  const candidates = textureRoots.flatMap((root) => textureCandidates(root, normalized));

  for (const candidate of candidates) {
    const cacheKey = candidate;
    if (textureCache.has(cacheKey)) {
      const cached = textureCache.get(cacheKey);
      if (cached) return cached;
      continue;
    }
    if (!fs.existsSync(candidate)) {
      textureCache.set(cacheKey, null);
      continue;
    }
    try {
      const texture = await Jimp.read(candidate);
      textureCache.set(cacheKey, texture);
      return texture;
    } catch {
      textureCache.set(cacheKey, null);
    }
  }

  return null;
}

function getTextureRoots(texturePath?: string): string[] {
  const roots = [
    texturePath,
    process.env.IF_ASSETS_DIR ? path.resolve(process.env.IF_ASSETS_DIR) : undefined,
    process.env.IF_ASSETS_DIR ? path.resolve(process.env.IF_ASSETS_DIR, 'textures') : undefined,
    path.resolve(MODULE_DIR, '..', '..', 'assets'),
    path.resolve(MODULE_DIR, '..', '..', 'assets', 'textures'),
  ].filter((root): root is string => Boolean(root));

  return [...new Set(roots)].filter((root) => fs.existsSync(root));
}

function textureCandidates(root: string, normalizedMaterial: string): string[] {
  const blockVariants = [
    normalizedMaterial,
    `${normalizedMaterial}_side`,
    `${normalizedMaterial}_top`,
    `${normalizedMaterial}_front`,
    `${normalizedMaterial}_bottom`,
    `${normalizedMaterial}_end`,
  ];

  return [
    path.join(root, 'assets', 'minecraft', 'textures', 'item', `${normalizedMaterial}.png`),
    path.join(root, 'assets', 'minecraft', 'textures', 'block', `${normalizedMaterial}.png`),
    path.join(root, 'textures', 'item', `${normalizedMaterial}.png`),
    path.join(root, 'item', `${normalizedMaterial}.png`),
    path.join(root, `${normalizedMaterial}.png`),
    ...blockVariants.flatMap((variant) => [
      path.join(root, 'assets', 'minecraft', 'textures', 'block', `${variant}.png`),
      path.join(root, 'textures', 'block', `${variant}.png`),
      path.join(root, 'block', `${variant}.png`),
    ]),
  ];
}

function slotToPixels(col: number, row: number, padding: number, titleBar: number, slotSize: number, gap: number) {
  return {
    x: padding + col * (slotSize + gap),
    y: padding + titleBar + row * (slotSize + gap),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToJimpColor(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return (((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0);
}

function shadeColor(color: number, amount: number): number {
  const r = clamp(((color >>> 24) & 0xFF) + amount, 0, 255);
  const g = clamp(((color >>> 16) & 0xFF) + amount, 0, 255);
  const b = clamp(((color >>> 8) & 0xFF) + amount, 0, 255);
  return (((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0);
}
