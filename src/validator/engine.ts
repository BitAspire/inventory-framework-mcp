import { GUIModel, PaneModel, ValidationIssue } from '../parser/models.js';
import { getAtlasEntry } from '../renderer/item-atlas.js';

export function validateGUIModel(gui: GUIModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const columns = columnsForGui(gui);
  const rows = rowsForGui(gui);

  if (gui.type === 'chest' && gui.rows > 6) {
    issues.push({
      ruleId: 'gui-rows-limit',
      severity: 'error',
      message: `ChestGui cannot have more than 6 rows (found ${gui.rows}).`,
      location: 'GUI constructor',
    });
  }

  // Rule: pane-out-of-bounds + pane-overlap
  const occupied = new Set<string>();
  for (const pane of gui.panes) {
    const maxX = pane.x + pane.length;
    const maxY = pane.y + pane.height;

    if (maxX > columns) {
      issues.push({
        ruleId: 'pane-out-of-bounds',
        severity: 'error',
        message: `Pane ${pane.type} exceeds horizontal grid (x=${pane.x}, length=${pane.length}, gui columns=${columns}).`,
        location: `Pane at (${pane.x},${pane.y})`,
      });
    }
    if (maxY > rows) {
      issues.push({
        ruleId: 'pane-out-of-bounds',
        severity: 'error',
        message: `Pane ${pane.type} exceeds vertical grid (y=${pane.y}, height=${pane.height}, gui rows=${rows}).`,
        location: `Pane at (${pane.x},${pane.y})`,
      });
    }

    for (let py = pane.y; py < maxY; py++) {
      for (let px = pane.x; px < maxX; px++) {
        const key = `${px},${py}`;
        if (occupied.has(key)) {
          issues.push({
            ruleId: 'pane-overlap',
            severity: 'warning',
            message: `Pane overlap detected at slot (${px},${py}).`,
            location: `Pane at (${pane.x},${pane.y})`,
          });
        }
        occupied.add(key);
      }
    }
  }

  // Rule: unknown-material
  const seen = new Set<string>();
  const allItems = [...gui.orphanItems, ...gui.panes.flatMap((p) => p.items)].filter((item) => {
    const key = `${item.material}-${item.displayName}-${item.slotX}-${item.slotY}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const item of allItems) {
    if (!item.material || item.material === 'UNKNOWN') {
      issues.push({
        ruleId: 'unknown-material',
        severity: 'error',
        message: 'Item has no valid Material specified.',
        location: item.displayName || 'Unnamed item',
      });
    } else if (!getAtlasEntry(item.material)) {
      issues.push({
        ruleId: 'unknown-material',
        severity: 'warning',
        message: `Material ${item.material} is not in the local atlas. Rendering will use a generic fallback icon.`,
        location: item.displayName || item.material,
      });
    }
  }

  // Rule: missing-displayname
  for (const item of allItems) {
    if (!item.displayName && isInteractiveMaterial(item.material)) {
      issues.push({
        ruleId: 'missing-displayname',
        severity: 'warning',
        message: `Item ${item.material} lacks a display name. Players may not understand its purpose.`,
        location: item.displayName || item.material,
      });
    }
  }

  // Rule: empty-slot-waste
  const guiSlots = rows * columns;
  const usedSlots = occupied.size;
  if (usedSlots < guiSlots * 0.3 && gui.rows > 2) {
    issues.push({
      ruleId: 'empty-slot-waste',
      severity: 'info',
      message: `GUI is quite empty (${usedSlots}/${guiSlots} slots used). Consider reducing rows or filling space.`,
      location: 'GUI layout',
    });
  }

  return issues;
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

function isInteractiveMaterial(mat: string): boolean {
  // Heuristic: most blocks are decorative; items/buttons usually need names
  const decorative = [
    'STONE','GRASS_BLOCK','DIRT','COBBLESTONE','OAK_PLANKS','SPRUCE_PLANKS','BIRCH_PLANKS',
    'SAND','GRAVEL','GLASS','BRICKS','MOSSY_COBBLESTONE','OBSIDIAN','DIAMOND_ORE','IRON_ORE',
    'COAL_ORE','GOLD_ORE','REDSTONE_ORE','LAPIS_ORE','EMERALD_ORE','BEDROCK','WATER','LAVA',
  ];
  return !decorative.includes(mat.toUpperCase());
}
