import { Jimp } from 'jimp';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'node:crypto';
import { GUIModel, ItemModel, PaneModel } from '../parser/models.js';
import { getAtlasEntry, getFallbackColor } from './item-atlas.js';
import {
  chooseWinner,
  describeContributor,
  getLayoutBounds,
  resolveLayout,
  resolveSlot,
  type SlotContributor,
} from '../layout/slot-resolution.js';
import {
  drawMinecraftTextLine,
  measureMinecraftTextWidth,
  stripMinecraftFormatting,
} from './minecraft-text.js';

const SLOT_SIZE_BASE = 68;
const GAP_BASE = 13;
const PADDING_BASE = 30;
const TITLE_BAR_BASE = 0;
const TITLE_HEIGHT_BASE = 55;
const WINDOW_RADIUS_BASE = 12;
const MODULE_DIR = __dirname;

export interface RenderOptions {
  scale?: number;
  texturePath?: string;
  outputPath?: string;
  hoverSlot?: { x: number; y: number };
  showTooltip?: boolean;
}

export interface MatrixLegendItem {
  material: string;
  name?: string;
  lore?: string[];
  amount?: number;
  clickHandler?: boolean;
}

export interface MatrixSpec {
  title?: string;
  rows: number;
  layout: string[];
  legend: Record<string, MatrixLegendItem>;
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
    imagePath: string;
    width: number;
    height: number;
    slots: RenderedSlotMetadata[];
  };
}

export interface RenderDimensions {
  width: number;
  height: number;
  columns: number;
  rows: number;
}

export interface RenderedSlotMetadata {
  x: number;
  y: number;
  material: string;
  displayName?: string;
  lore?: string[];
  plainDisplayName?: string;
  plainLore?: string[];
  amount?: number;
  hasClickHandler?: boolean;
  priority: number;
  contributors: string[];
}

const textureCache = new Map<string, any | null>();

export function guiFromMatrixSpec(spec: MatrixSpec): GUIModel {
  const rows = Math.max(1, spec.rows);
  const paneItems: ItemModel[] = [];

  spec.layout.slice(0, rows).forEach((rowText, row) => {
    [...rowText].slice(0, 9).forEach((cell, col) => {
      const legend = spec.legend[cell];
      if (!legend) return;
      paneItems.push({
        material: legend.material,
        displayName: legend.name,
        lore: legend.lore,
        amount: legend.amount,
        hasClickHandler: legend.clickHandler,
        slotX: col,
        slotY: row,
      });
    });
  });

  return {
    type: 'chest',
    rows,
    title: spec.title ?? '',
    panes: [
      {
        x: 0,
        y: 0,
        length: 9,
        height: rows,
        type: 'StaticPane',
        priority: -200,
        priorityLabel: 'LOWEST',
        positionSource: 'constructor',
        visible: true,
        items: paneItems,
      },
    ],
    orphanItems: [],
  };
}

export async function renderGUIBase64(gui: GUIModel, scale = 2): Promise<string> {
  return (await renderGUI(gui, { scale })).base64;
}

export function getRenderDimensions(gui: GUIModel, scale = 2): RenderDimensions {
  const slotSize = SLOT_SIZE_BASE * scale;
  const gap = GAP_BASE * scale;
  const padding = PADDING_BASE * scale;
  const titleBar = TITLE_BAR_BASE * scale;
  const titleHeight = getHeaderHeight(gui, scale);
  const bounds = getLayoutBounds(gui);

  return {
    columns: bounds.columns,
    rows: bounds.rows,
    width: padding * 2 + bounds.columns * slotSize + (bounds.columns - 1) * gap,
    height: padding * 2 + titleHeight + titleBar + bounds.rows * slotSize + (bounds.rows - 1) * gap,
  };
}

export async function renderGUI(gui: GUIModel, options: RenderOptions = {}): Promise<RenderResult> {
  const scale = options.scale ?? 2;
  const slotSize = SLOT_SIZE_BASE * scale;
  const gap = GAP_BASE * scale;
  const padding = PADDING_BASE * scale;
  const titleBar = TITLE_BAR_BASE * scale;
  const titleHeight = getHeaderHeight(gui, scale);
  const bounds = getLayoutBounds(gui);
  const { width, height, columns: cols, rows } = getRenderDimensions(gui, scale);

  const image = new Jimp({ width, height, color: 0x00000000 });
  const layout = resolveLayout(gui, bounds);

  drawWindow(image, width, height, padding, titleBar, titleHeight);
  await drawTitle(image, padding, titleHeight, width, gui.title, scale);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const { x, y } = slotToPixels(c, r, padding, titleHeight, titleBar, slotSize, gap);
      drawSlot(image, x, y, slotSize);
    }
  }

  for (const pane of gui.panes) {
    drawPane(image, pane, padding, titleHeight, titleBar, slotSize, gap, scale);
  }

  const fallbackItems = new Set<string>();
  const unknownMaterials = new Set<string>();
  const slots: RenderedSlotMetadata[] = [];
  let texturedItems = 0;

  for (const slot of layout.slots.values()) {
    if (!slot.winner) continue;
    const item = slot.winner.item;
    if (!getAtlasEntry(item.material)) unknownMaterials.add(item.material);
    const drawn = await drawItem(image, slot.winner, padding, titleHeight, titleBar, slotSize, gap, scale, options.texturePath);
    if (drawn) texturedItems++;
    else fallbackItems.add(item.material);
    slots.push(createSlotMetadata(slot.winner, slot.contributors));
  }

  if ((options.showTooltip ?? Boolean(options.hoverSlot)) && options.hoverSlot) {
    const hovered = resolveSlot(layout, options.hoverSlot.x, options.hoverSlot.y);
    if (hovered?.winner) {
      await drawTooltip(image, hovered.winner, padding, titleHeight, titleBar, slotSize, gap, scale);
    }
  }

  const outputPath = await persistPreview(image, options.outputPath);
  const buf = await image.getBuffer('image/png');

  return {
    base64: buf.toString('base64'),
    metadata: {
      title: gui.title,
      guiType: gui.type,
      columns: cols,
      rows,
      renderedItems: slots.length,
      texturedItems,
      fallbackItems: [...fallbackItems].sort(),
      unknownMaterials: [...unknownMaterials].sort(),
      imagePath: outputPath,
      width,
      height,
      slots,
    },
  };
}

function createSlotMetadata(winner: SlotContributor, contributors: SlotContributor[]): RenderedSlotMetadata {
  return {
    x: winner.col,
    y: winner.row,
    material: winner.item.material,
    displayName: winner.item.displayName,
    lore: winner.item.lore,
    plainDisplayName: winner.item.displayName ? stripMinecraftFormatting(winner.item.displayName) : undefined,
    plainLore: winner.item.lore?.map((line) => stripMinecraftFormatting(line)),
    amount: winner.item.amount,
    hasClickHandler: winner.item.hasClickHandler,
    priority: winner.priority,
    contributors: contributors.map((c) => describeContributor(c)),
  };
}

async function persistPreview(image: any, outputPath?: string): Promise<string> {
  const target = outputPath
    ? path.resolve(outputPath)
    : path.join(os.tmpdir(), 'inventory-framework-mcp', `${randomUUID()}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await image.write(target);
  return target;
}

function drawWindow(img: any, width: number, height: number, padding: number, titleBar: number, titleHeight: number) {
  const radius = WINDOW_RADIUS_BASE * Math.max(1, padding / PADDING_BASE);
  drawRoundedRect(img, 0, 0, width, height, radius, 0xD8D8D8FF);

  if (titleBar > 0) {
    drawRect(img, padding, padding + titleHeight, width - padding * 2, titleBar, 0xA0A0A0FF);
    drawRect(img, padding, padding + titleHeight, width - padding * 2, 1, 0xFDFDFDFF);
    drawRect(img, padding, padding + titleHeight + titleBar - 1, width - padding * 2, 1, 0x8B8B8BFF);
  }
}

async function drawTitle(img: any, padding: number, titleHeight: number, width: number, title: string, scale: number) {
  if (!shouldRenderHeader(title) || titleHeight <= 0) return;
  const titleScale = Math.max(2, Math.round(scale * 1.5));
  const titleX = padding + 5 * scale;
  const titleY = padding + 10 * scale;
  await drawMinecraftTextLine(img, titleX + titleScale, titleY + titleScale, title, '#F4F4F4', titleScale);
  await drawMinecraftTextLine(img, titleX, titleY, title, '#050505', titleScale);
}

function drawSlot(img: any, x: number, y: number, size: number) {
  const radius = Math.max(3, Math.round(size * 0.045));
  drawRoundedRect(img, x, y, size, size, radius, 0x4F4F4FFF);
  drawRoundedRect(img, x + 2, y + 2, size - 4, size - 4, Math.max(1, radius - 2), 0xF8F8F8FF);
}

function drawPane(_img: any, _pane: PaneModel, _padding: number, _titleHeight: number, _titleBar: number, _slotSize: number, _gap: number, _scale: number) {
  // Pane bounds are intentionally not rendered. The preview should show the final GUI slots/items,
  // not helper outlines from IF pane types such as OutlinePane or PaginatedPane.
}

async function drawItem(
  img: any,
  slot: SlotContributor,
  padding: number,
  titleHeight: number,
  titleBar: number,
  slotSize: number,
  gap: number,
  scale: number,
  texturePath?: string
): Promise<boolean> {
  const { item, col, row } = slot;
  const { x, y } = slotToPixels(col, row, padding, titleHeight, titleBar, slotSize, gap);
  const iconMargin = Math.max(8, 8 * scale);
  const iconSize = slotSize - iconMargin * 2;
  const iconX = x + iconMargin;
  const iconY = y + iconMargin;

  const texture = await loadTexture(item.material, texturePath);
  if (texture) {
    const resized = resizeNearest(texture, iconSize, iconSize);
    img.composite(resized, iconX, iconY);
  } else {
    drawFallbackIcon(img, item, iconX, iconY, iconSize, scale);
  }

  if (item.enchanted) drawGlint(img, iconX, iconY, iconSize, scale);
  if (item.customModelData !== undefined) drawRect(img, x + slotSize - 7 * scale, y + 2 * scale, 5 * scale, 5 * scale, 0x4AA3FFFF);
  if (item.amount && item.amount > 1) drawStackBadge(img, x, y, slotSize, scale);

  return Boolean(texture);
}

async function drawTooltip(img: any, slot: SlotContributor, padding: number, titleHeight: number, titleBar: number, slotSize: number, gap: number, scale: number) {
  const item = slot.item;
  const lines = buildTooltipLines(item);
  if (lines.length === 0) return;

  const maxTextWidth = Math.max(...(await Promise.all(lines.map((line) => measureMinecraftTextWidth(line)))), 0);
  const fontHeight = 18;
  const tooltipWidth = Math.max(64 * scale / 2, maxTextWidth + 12 * scale);
  const tooltipHeight = lines.length * (fontHeight + 2) + 10 * scale;

  const slotPx = slotToPixels(slot.col, slot.row, padding, titleHeight, titleBar, slotSize, gap);
  let x = slotPx.x + slotSize + 8 * scale;
  let y = slotPx.y;

  if (x + tooltipWidth > img.bitmap.width - 8) {
    x = Math.max(8, slotPx.x - tooltipWidth - 8 * scale);
  }
  if (y + tooltipHeight > img.bitmap.height - 8) {
    y = Math.max(8, img.bitmap.height - tooltipHeight - 8);
  }

  drawTooltipBox(img, x, y, tooltipWidth, tooltipHeight);
  let cursorY = y + 4 * scale;
  for (const line of lines) {
    await drawMinecraftTextLine(img, x + 6 * scale, cursorY, line, '#FFFFFF');
    cursorY += fontHeight + 2;
  }
}

function buildTooltipLines(item: ItemModel): string[] {
  const lines: string[] = [];
  lines.push(item.displayName ?? item.material);
  if (item.amount && item.amount > 1) lines.push(`&7x${item.amount}`);
  if (item.lore?.length) lines.push(...item.lore);
  return lines;
}

function drawTooltipBox(img: any, x: number, y: number, w: number, h: number) {
  drawRect(img, x, y, w, h, 0x100010E6);
  drawRect(img, x + 1, y + 1, w - 2, h - 2, 0x2B2B2BDD);
  drawRect(img, x + 2, y + 2, w - 4, h - 4, 0x3A3A3AD8);
  drawRect(img, x, y, w, 1, 0xFFFFFFFF);
  drawRect(img, x, y + h - 1, w, 1, 0xFFFFFFFF);
  drawRect(img, x, y, 1, h, 0xFFFFFFFF);
  drawRect(img, x + w - 1, y, 1, h, 0xFFFFFFFF);
}

function drawFallbackIcon(img: any, item: ItemModel, x: number, y: number, size: number, scale: number) {
  const base = hexToJimpColor(getFallbackColor(item.material));
  const dark = shadeColor(base, -50);
  const darker = shadeColor(base, -80);
  const light = shadeColor(base, 50);
  const lighter = shadeColor(base, 80);
  const material = item.material.toUpperCase();

  if (material.includes('SWORD')) {
    const centerX = x + size * 0.5;
    const centerY = y + size * 0.5;
    drawLine(img, centerX - size * 0.15, centerY - size * 0.35, centerX + size * 0.15, centerY - size * 0.35, Math.max(2, 3 * scale), lighter);
    drawLine(img, centerX - size * 0.12, centerY - size * 0.32, centerX + size * 0.12, centerY - size * 0.32, Math.max(1, scale), darker);
    drawLine(img, centerX - size * 0.08, centerY - size * 0.15, centerX - size * 0.08, centerY + size * 0.35, Math.max(2, 3 * scale), light);
    drawLine(img, centerX + size * 0.08, centerY - size * 0.15, centerX + size * 0.08, centerY + size * 0.35, Math.max(2, 3 * scale), dark);
    drawRect(img, centerX - size * 0.1, centerY + size * 0.3, size * 0.2, Math.max(2, 4 * scale), 0x6A442AFF);
    drawRect(img, centerX - size * 0.06, centerY + size * 0.35, size * 0.12, Math.max(1, 2 * scale), 0x4A2818FF);
    return;
  }

  if (material.includes('PICKAXE') || material.includes('AXE')) {
    const centerX = x + size * 0.5;
    const centerY = y + size * 0.45;
    drawRect(img, centerX - size * 0.25, centerY - size * 0.2, size * 0.5, Math.max(3, 5 * scale), lighter);
    drawRect(img, centerX - size * 0.23, centerY - size * 0.18, size * 0.46, Math.max(1, 2 * scale), darker);
    drawRect(img, centerX - size * 0.25, centerY, size * 0.5, Math.max(1, 2 * scale), dark);
    drawLine(img, centerX, centerY + size * 0.04, centerX + size * 0.05, centerY + size * 0.35, Math.max(2, 2 * scale), 0x6A442AFF);
    return;
  }

  if (material.includes('APPLE') || material.includes('BERRY')) {
    drawDiamond(img, x + size * 0.15, y + size * 0.18, size * 0.7, base, dark, light);
    drawRect(img, x + size * 0.52, y + size * 0.08, Math.max(2, 2 * scale), size * 0.16, 0x5D3A1AFF);
    return;
  }

  if (material.includes('POTION') || material.includes('BOTTLE')) {
    drawRect(img, x + size * 0.35, y + size * 0.08, size * 0.3, size * 0.24, 0xD0E8F2FF);
    drawRect(img, x + size * 0.22, y + size * 0.32, size * 0.56, size * 0.5, base);
    drawRect(img, x + size * 0.28, y + size * 0.38, size * 0.44, size * 0.22, light);
    drawRect(img, x + size * 0.31, y + size * 0.42, size * 0.38, Math.max(1, scale), darker);
    return;
  }

  if (material.includes('HEAD') || material.includes('SKULL')) {
    drawRect(img, x + size * 0.18, y + size * 0.16, size * 0.64, size * 0.64, base);
    drawRect(img, x + size * 0.18, y + size * 0.16, size * 0.64, Math.max(1, 2 * scale), light);
    drawRect(img, x + size * 0.28, y + size * 0.35, size * 0.12, size * 0.12, dark);
    drawRect(img, x + size * 0.6, y + size * 0.35, size * 0.12, size * 0.12, dark);
    drawRect(img, x + size * 0.38, y + size * 0.62, size * 0.24, Math.max(2, 2 * scale), dark);
    return;
  }

  if (material.includes('GLASS_PANE')) {
    drawRect(img, x + size * 0.42, y + size * 0.08, size * 0.16, size * 0.84, light);
    drawRect(img, x + size * 0.18, y + size * 0.42, size * 0.64, size * 0.16, light);
    drawRect(img, x + size * 0.44, y + size * 0.1, Math.max(1, scale), size * 0.8, darker);
    drawRect(img, x + size * 0.2, y + size * 0.44, size * 0.6, Math.max(1, scale), darker);
    return;
  }

  if (material.includes('GLASS')) {
    drawRect(img, x + size * 0.12, y + size * 0.12, size * 0.76, size * 0.76, light);
    drawRect(img, x + size * 0.15, y + size * 0.15, size * 0.7, Math.max(1, scale), lighter);
    drawRect(img, x + size * 0.15, y + size * 0.15, Math.max(1, scale), size * 0.7, lighter);
    return;
  }

  if (getAtlasEntry(material)?.category === 'blocks' || material.endsWith('_BLOCK')) {
    drawBlock(img, x, y, size, base, dark, light);
    return;
  }

  drawDiamond(img, x + size * 0.12, y + size * 0.12, size * 0.76, base, dark, light);
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

function slotToPixels(col: number, row: number, padding: number, titleHeight: number, titleBar: number, slotSize: number, gap: number) {
  return {
    x: padding + col * (slotSize + gap),
    y: padding + titleHeight + titleBar + row * (slotSize + gap),
  };
}

function shouldRenderHeader(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'untitled';
}

function getHeaderHeight(gui: GUIModel, scale: number): number {
  return shouldRenderHeader(gui.title) ? TITLE_HEIGHT_BASE * scale : 0;
}

function drawRoundedRect(img: any, x: number, y: number, w: number, h: number, radius: number, color: number) {
  const startX = Math.round(x);
  const startY = Math.round(y);
  const width = Math.max(0, Math.round(w));
  const height = Math.max(0, Math.round(h));
  const r = Math.max(0, Math.round(Math.min(radius, width / 2, height / 2)));

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const cornerX = dx < r ? r : dx >= width - r ? width - r - 1 : dx;
      const cornerY = dy < r ? r : dy >= height - r ? height - r - 1 : dy;
      const distX = dx - cornerX;
      const distY = dy - cornerY;
      if (distX * distX + distY * distY <= r * r) {
        const px = startX + dx;
        const py = startY + dy;
        if (px >= 0 && py >= 0 && px < img.bitmap.width && py < img.bitmap.height) {
          img.setPixelColor(color, px, py);
        }
      }
    }
  }
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

function resizeNearest(source: any, width: number, height: number): any {
  const target = new Jimp({ width, height, color: 0x00000000 });
  const srcWidth = source.bitmap.width;
  const srcHeight = source.bitmap.height;

  for (let y = 0; y < height; y++) {
    const srcY = Math.min(srcHeight - 1, Math.floor((y * srcHeight) / height));
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(srcWidth - 1, Math.floor((x * srcWidth) / width));
      target.setPixelColor(source.getPixelColor(srcX, srcY), x, y);
    }
  }

  return target;
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

function drawBlock(img: any, x: number, y: number, size: number, base: number, dark: number, light: number) {
  drawRect(img, x + size * 0.15, y + size * 0.15, size * 0.7, size * 0.7, base);
  drawRect(img, x + size * 0.15, y + size * 0.15, size * 0.7, Math.max(1, 2), light);
  drawRect(img, x + size * 0.15, y + size * 0.15, Math.max(1, 2), size * 0.7, light);
  drawRect(img, x + size * 0.8, y + size * 0.15, Math.max(1, 2), size * 0.7, dark);
  drawRect(img, x + size * 0.15, y + size * 0.8, size * 0.7, Math.max(1, 2), dark);
}

function drawDiamond(img: any, x: number, y: number, size: number, base: number, dark: number, light: number) {
  const cx = x + size / 2;
  for (let row = 0; row < size; row++) {
    const halfWidth = size / 2 - Math.abs(row - size / 2);
    drawRect(img, cx - halfWidth, y + row, halfWidth * 2, 1, base);
  }
  drawLine(img, x + size * 0.5, y, x + size, y + size * 0.5, 2, light);
  drawLine(img, x, y + size * 0.5, x + size * 0.5, y + size, 2, dark);
  drawLine(img, x + size, y + size * 0.5, x + size * 0.5, y + size, 2, dark);
  drawLine(img, x + size * 0.5, y + size * 0.05, x + size * 0.95, y + size * 0.5, 1, shadeColor(light, 30));
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
