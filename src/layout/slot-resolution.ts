import { GUIModel, ItemModel, PaneModel } from '../parser/models.js';

export interface SlotContributor {
  paneIndex: number;
  itemIndex: number;
  pane: PaneModel;
  item: ItemModel;
  col: number;
  row: number;
  localCol: number;
  localRow: number;
  priority: number;
}

export interface ResolvedSlot {
  col: number;
  row: number;
  contributors: SlotContributor[];
  winner?: SlotContributor;
}

export interface ResolvedLayout {
  columns: number;
  rows: number;
  slots: Map<string, ResolvedSlot>;
  contributors: SlotContributor[];
}

export function columnsForGui(gui: GUIModel): number {
  if (gui.type === 'hopper') return 5;
  if (gui.type === 'dropper' || gui.type === 'dispenser') return 3;
  return 9;
}

export function rowsForGui(gui: GUIModel): number {
  if (gui.type === 'hopper') return 1;
  if (gui.type === 'dropper' || gui.type === 'dispenser') return 3;
  return gui.rows;
}

export function getPanePriority(pane: PaneModel, columns: number, rows: number): number {
  if (pane.priorityLabel) {
    const label = pane.priorityLabel.toUpperCase();
    if (label === 'LOWEST') return -300;
    if (label === 'LOW') return -150;
    if (label === 'NORMAL') return 0;
    if (label === 'HIGH') return 150;
    if (label === 'HIGHEST') return 300;
  }

  if (pane.priority !== 0) return pane.priority;

  if (pane.x === 0 && pane.y === 0 && pane.length >= columns && pane.height >= rows) {
    return -200;
  }

  return 0;
}

export function resolveLayout(gui: GUIModel): ResolvedLayout {
  const columns = columnsForGui(gui);
  const rows = rowsForGui(gui);
  const slots = new Map<string, ResolvedSlot>();
  const contributors: SlotContributor[] = [];

  const pushContributor = (contributor: SlotContributor) => {
    contributors.push(contributor);
    const key = slotKey(contributor.col, contributor.row);
    const slot = slots.get(key) ?? { col: contributor.col, row: contributor.row, contributors: [] };
    slot.contributors.push(contributor);
    slot.winner = chooseWinner(slot.contributors);
    slots.set(key, slot);
  };

  gui.orphanItems.forEach((item, index) => {
    const col = clamp(item.slotX ?? 0, 0, columns - 1);
    const row = clamp(item.slotY ?? 0, 0, rows - 1);
    pushContributor({
      paneIndex: -1,
      itemIndex: index,
      pane: {
        x: 0,
        y: 0,
        length: 1,
        height: 1,
        type: 'orphan',
        priority: 0,
        visible: true,
        items: [],
      },
      item,
      col,
      row,
      localCol: item.slotX ?? 0,
      localRow: item.slotY ?? 0,
      priority: 0,
    });
  });

  gui.panes.forEach((pane, paneIndex) => {
    if (pane.visible === false) return;
    const panePriority = getPanePriority(pane, columns, rows);
    pane.items.forEach((item, itemIndex) => {
      const local = resolvePaneItemPosition(pane, item, itemIndex);
      const col = pane.x + local.col;
      const row = pane.y + local.row;
      if (col < 0 || row < 0 || col >= columns || row >= rows) return;

      pushContributor({
        paneIndex,
        itemIndex,
        pane,
        item,
        col,
        row,
        localCol: local.col,
        localRow: local.row,
        priority: panePriority,
      });
    });
  });

  return { columns, rows, slots, contributors };
}

export function resolveSlot(layout: ResolvedLayout, col: number, row: number): ResolvedSlot | undefined {
  return layout.slots.get(slotKey(col, row));
}

export function describeContributor(contributor: SlotContributor): string {
  const paneLabel = contributor.paneIndex >= 0 ? contributor.pane.type : 'orphan';
  const priority = describePriority(contributor.priority);
  return `${paneLabel} ${priority} at (${contributor.col},${contributor.row})`;
}

export function describePriority(priority: number): string {
  if (priority <= -200) return 'LOWEST';
  if (priority <= -150) return 'LOW';
  if (priority >= 300) return 'HIGHEST';
  if (priority >= 150) return 'HIGH';
  if (priority === 0) return 'NORMAL';
  return String(priority);
}

export function chooseWinner(contributors: SlotContributor[]): SlotContributor | undefined {
  return [...contributors].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.paneIndex !== b.paneIndex) return a.paneIndex - b.paneIndex;
    return a.itemIndex - b.itemIndex;
  }).at(-1);
}

function resolvePaneItemPosition(pane: PaneModel, item: ItemModel, index: number): { col: number; row: number } {
  if (item.slotX !== undefined && item.slotY !== undefined) {
    return { col: item.slotX, row: item.slotY };
  }

  if (pane.type === 'OutlinePane') {
    const outlineSlots = outlinePositions(pane.length, pane.height);
    return outlineSlots[index % Math.max(1, outlineSlots.length)] ?? { col: 0, row: 0 };
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

function slotKey(col: number, row: number): string {
  return `${col},${row}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
