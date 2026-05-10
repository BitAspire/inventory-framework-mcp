export interface GUIModel {
  type: 'chest' | 'hopper' | 'dispenser' | 'unknown';
  rows: number;
  title: string;
  panes: PaneModel[];
  orphanItems: ItemModel[];
}

export interface PaneModel {
  x: number;
  y: number;
  length: number;
  height: number;
  type: string; // e.g. 'OutlinePane', 'StaticPane', 'PaginatedPane'
  priority: number;
  visible: boolean;
  items: ItemModel[];
  // For outline pane specific
  thickness?: number;
}

export interface ItemModel {
  material: string;
  displayName?: string;
  lore?: string[];
  amount?: number;
  slotX?: number;
  slotY?: number;
  // builder flags
  enchanted?: boolean;
  customModelData?: number;
  skullTexture?: string;
}

export interface ValidationIssue {
  ruleId: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  location?: string; // e.g. "Pane at (2,3)" or "Item DIAMOND"
}

export interface ParsedResult {
  gui: GUIModel | null;
  issues: ValidationIssue[];
}
