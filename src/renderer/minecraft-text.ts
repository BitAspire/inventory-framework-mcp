import { Jimp, loadFont, measureText } from 'jimp';
import { SANS_16_WHITE, SANS_16_BLACK } from 'jimp/fonts';

const WHITE_FONT = loadFont(SANS_16_WHITE);
const BLACK_FONT = loadFont(SANS_16_BLACK);

const COLOR_CODES: Record<string, string> = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
};

export interface StyledTextSegment {
  text: string;
  color: string;
}

export async function getFonts() {
  return {
    white: await WHITE_FONT,
    black: await BLACK_FONT,
  };
}

export function stripMinecraftFormatting(input: string): string {
  return input.replace(/(?:§|&)[0-9A-FK-OR]/gi, '').replace(/(?:§|&)[k-or]/gi, '');
}

export function parseMinecraftText(input: string, defaultColor = '#FFFFFF'): StyledTextSegment[] {
  const segments: StyledTextSegment[] = [];
  let currentColor = defaultColor;
  let buffer = '';

  const flush = () => {
    if (buffer) {
      segments.push({ text: buffer, color: currentColor });
      buffer = '';
    }
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if ((ch === '&' || ch === '§') && i + 1 < input.length) {
      const code = input[i + 1]!.toLowerCase();
      if (code === 'r') {
        flush();
        currentColor = defaultColor;
        i++;
        continue;
      }
      if (COLOR_CODES[code]) {
        flush();
        currentColor = COLOR_CODES[code];
        i++;
        continue;
      }
      if ('klmo'.includes(code)) {
        i++;
        continue;
      }
    }
    buffer += ch;
  }

  flush();
  return segments.length > 0 ? segments : [{ text: input, color: defaultColor }];
}

export async function drawMinecraftTextLine(
  image: any,
  x: number,
  y: number,
  text: string,
  color = '#FFFFFF'
): Promise<number> {
  const font = await WHITE_FONT;
  return drawStyledSegments(image, x, y, parseMinecraftText(text, color), font);
}

export async function drawMinecraftTextBlock(
  image: any,
  x: number,
  y: number,
  lines: string[],
  color = '#FFFFFF',
  lineGap = 2
): Promise<{ width: number; height: number }> {
  const font = await WHITE_FONT;
  let cursorY = y;
  let maxWidth = 0;
  for (const line of lines) {
    maxWidth = Math.max(maxWidth, await drawStyledSegments(image, x, cursorY, parseMinecraftText(line, color), font));
    cursorY += font.common.lineHeight + lineGap;
  }
  return { width: maxWidth, height: cursorY - y - lineGap };
}

export async function measureMinecraftTextWidth(text: string): Promise<number> {
  const font = await WHITE_FONT;
  return measureText(font, stripMinecraftFormatting(text));
}

async function drawStyledSegments(image: any, x: number, y: number, segments: StyledTextSegment[], font: Awaited<typeof WHITE_FONT>): Promise<number> {
  let cursorX = x;
  for (const segment of segments) {
    if (!segment.text) continue;
    const segmentWidth = Math.max(1, Math.ceil(measureText(font, segment.text)));
    const layer = new Jimp({ width: segmentWidth, height: font.common.lineHeight, color: 0x00000000 });
    layer.print({ font, x: 0, y: 0, text: segment.text });
    tintTextLayer(layer, segment.color);
    image.composite(layer, cursorX, y);
    cursorX += segmentWidth;
  }
  return cursorX - x;
}

function tintTextLayer(layer: any, color: string) {
  const rgba = hexToRgba(color);
  layer.scan(0, 0, layer.bitmap.width, layer.bitmap.height, function (this: any, _x: number, _y: number, idx: number) {
    const alpha = this.bitmap.data[idx + 3];
    if (alpha === 0) return;
    this.bitmap.data[idx] = rgba.r;
    this.bitmap.data[idx + 1] = rgba.g;
    this.bitmap.data[idx + 2] = rgba.b;
    this.bitmap.data[idx + 3] = alpha;
  });
}

function hexToRgba(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}
