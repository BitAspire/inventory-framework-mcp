import { extractIFModel } from './parser/if-extractor.js';
import { renderGUIBase64 } from './renderer/gui-drawer.js';
import { validateGUIModel } from './validator/engine.js';
import * as fs from 'fs';

const sampleCode = `
ChestGui gui = new ChestGui(5, "Shop");
OutlinePane outlinePane = new OutlinePane(0, 0, 9, 5);
outlinePane.addItem(new GuiItem(new ItemStack(Material.DIAMOND_SWORD)));
outlinePane.addItem(new GuiItem(new ItemStack(Material.GOLD_INGOT), event -> {}));
StaticPane staticPane = new StaticPane(1, 1, 7, 3);
staticPane.bindItem(0, 0, new GuiItem(new ItemStack(Material.OAK_PLANKS)));
staticPane.bindItem(6, 2, new GuiItem(new ItemStack(Material.REDSTONE)));
gui.addPane(outlinePane);
gui.addPane(staticPane);
`;

async function main() {
  console.log('Parsing...');
  const parsed = extractIFModel(sampleCode);
  console.log('GUI:', JSON.stringify(parsed.gui, null, 2));
  console.log('Parse issues:', parsed.issues);

  if (parsed.gui) {
    console.log('Validating...');
    const valIssues = validateGUIModel(parsed.gui);
    console.log('Validation issues:', valIssues);

    console.log('Rendering...');
    const base64 = await renderGUIBase64(parsed.gui, 2);
    fs.writeFileSync('test-render.png', Buffer.from(base64, 'base64'));
    console.log('Saved test-render.png');
  }
}

main().catch(console.error);
