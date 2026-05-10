import { Jimp } from 'jimp';
import { GUIModel, ItemModel, PaneModel } from '../parser/models.js';
import { getFallbackColor } from './item-atlas.js';

const SLOT_SIZE_BASE = 32;
const GAP_BASE = 2;
const PADDING_BASE = 16;
const TITLE_BAR_BASE = 20;

export async function renderGUIBase64(gui: GUIModel, scale = 2): Promise<string> {
  const slotSize = SLOT_SIZE_BASE * scale;
  const gap = GAP_BASE * scale;
  const padding = PADDING_BASE * scale;
  const titleBar = TITLE_BAR_BASE * scale;

  const cols = 9;
  const rows = gui.rows;

  const width = padding * 2 + cols * slotSize + (cols - 1) * gap;
  const height = padding * 2 + titleBar + rows * slotSize + (rows - 1) * gap;

  // Minecraft chest-like background colors
  const bgColor = 0xC6C6C6FF;      // light gray main background
  const borderDark = 0x373737FF;   // dark border
  const borderLight = 0xFFFFFFFF;  // light border (highlight)
  const slotBg = 0x8B8B8BFF;       // slot background
  const slotBorderDark = 0x373737FF;
  const slotBorderLight = 0xFFFFFFFF;

  const image = new Jimp({ width, height, color: bgColor });

  // Draw outer border (bevel effect)
  drawRect(image, 0, 0, width, height, borderDark); // outer dark
  drawRect(image, 1, 1, width - 2, height - 2, bgColor); // inner fill

  // Draw title text background
  drawRect(image, padding, padding, width - padding * 2, titleBar, 0x8B8B8BFF);

  // Draw title text (placeholder: we skip font rendering to keep zero native deps)
  // The title is returned in the MCP tool response alongside the image.

  // Draw slot grid
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = padding + c * (slotSize + gap);
      const y = padding + titleBar + r * (slotSize + gap);
      drawSlot(image, x, y, slotSize, slotBg, slotBorderDark, slotBorderLight);
    }
  }

  // Draw panes (just outlines or subtle tints)
  for (const pane of gui.panes) {
    drawPane(image, pane, padding, titleBar, slotSize, gap, scale);
  }

  // Draw items
  const allItems = [...gui.orphanItems];
  for (const pane of gui.panes) {
    for (const item of pane.items) {
      allItems.push(item);
    }
  }

  for (const item of allItems) {
    drawItem(image, item, padding, titleBar, slotSize, gap, scale);
  }

  const buf = await image.getBuffer('image/png');
  return buf.toString('base64');
}

function drawRect(img: any, x: number, y: number, w: number, h: number, color: number) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px >= 0 && py >= 0 && px < img.bitmap.width && py < img.bitmap.height) {
        img.setPixelColor(color, px, py);
      }
    }
  }
}

function drawSlot(img: any, x: number, y: number, size: number, bg: number, dark: number, light: number) {
  // Dark border bottom-right
  drawRect(img, x + 1, y + 1, size - 1, size - 1, dark);
  // Light border top-left
  drawRect(img, x, y, size - 1, size - 1, light);
  // Inner background
  drawRect(img, x + 1, y + 1, size - 2, size - 2, bg);
}

function drawPane(img: any, pane: PaneModel, padding: number, titleBar: number, slotSize: number, gap: number, scale: number) {
  if (pane.type === 'OutlinePane') {
    const x = padding + pane.x * (slotSize + gap);
    const y = padding + titleBar + pane.y * (slotSize + gap);
    const w = pane.length * (slotSize + gap) - gap;
    const h = pane.height * (slotSize + gap) - gap;
    // Draw outline
    const outlineColor = 0x555555FF;
    const thickness = Math.max(1, 2 * scale);
    drawRect(img, x - thickness, y - thickness, w + thickness * 2, thickness, outlineColor); // top
    drawRect(img, x - thickness, y + h, w + thickness * 2, thickness, outlineColor); // bottom
    drawRect(img, x - thickness, y - thickness, thickness, h + thickness * 2, outlineColor); // left
    drawRect(img, x + w, y - thickness, thickness, h + thickness * 2, outlineColor); // right
  }
}

function drawItem(img: any, item: ItemModel, padding: number, titleBar: number, slotSize: number, gap: number, scale: number) {
  // Determine slot position
  let col = item.slotX ?? 0;
  let row = item.slotY ?? 0;

  // If item doesn't have explicit slot and is inside a pane, try to infer position
  // For simplicity, orphan items without slot go to (0,0) or we skip them
  if (item.slotX === undefined || item.slotY === undefined) {
    // Try to find it inside a pane - for now just place at (0,0)
    col = 0;
    row = 0;
  }

  const x = padding + col * (slotSize + gap);
  const y = padding + titleBar + row * (slotSize + gap);
  const size = slotSize;

  const hex = getFallbackColor(item.material);
  const color = hexToJimpColor(hex);

  // Draw item placeholder (colored square with slight border)
  const innerMargin = Math.max(2, 2 * scale);
  drawRect(img, x + innerMargin, y + innerMargin, size - innerMargin * 2, size - innerMargin * 2, color);

  // Draw amount if > 1
  if (item.amount && item.amount > 1) {
    // Simple amount indicator: white block bottom-right corner
    const amountSize = Math.max(6, 6 * scale);
    drawRect(img, x + size - amountSize - 2, y + size - amountSize - 2, amountSize, amountSize, 0xFFFFFFFF);
    // We skip drawing actual numbers to avoid needing font rendering for now
  }
}

function hexToJimpColor(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return (((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0);
}
