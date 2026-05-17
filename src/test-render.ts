import { extractIFModel } from './parser/if-extractor.js';
import { renderGUIBase64 } from './renderer/gui-drawer.js';
import { validateGUIModel } from './validator/engine.js';
import * as fs from 'fs';

const sampleCode = `
ChestGui gui = new ChestGui(5, "Shop");
OutlinePane outlinePane = new OutlinePane(0, 0, 9, 5);
outlinePane.addItem(new GuiItem(new ItemStack(Material.DIAMOND_SWORD), "§6Buy Sword", event -> {}));
outlinePane.addItem(new GuiItem(new ItemStack(Material.GOLD_INGOT), "§eGold Coin"));
StaticPane staticPane = new StaticPane(1, 1, 7, 3);
staticPane.bindItem(0, 0, new GuiItem(new ItemStack(Material.OAK_PLANKS), "§6Planks"));
staticPane.bindItem(6, 2, new GuiItem(new ItemStack(Material.REDSTONE), "§cRedstone"));
gui.addPane(outlinePane);
gui.addPane(staticPane);
`;

async function main() {
  console.log('Parsing...');
  const parsed = extractIFModel(sampleCode);
  console.log('GUI Title:', parsed.gui?.title);
  console.log('Parse issues:', parsed.issues);

  if (parsed.gui) {
    console.log('Validating...');
    const valIssues = validateGUIModel(parsed.gui);
    console.log('Validation issues:', valIssues.length ? valIssues : 'None');

    console.log('Rendering...');
    const base64 = await renderGUIBase64(parsed.gui, 2);
    fs.writeFileSync('test-render.png', Buffer.from(base64, 'base64'));
    console.log('✓ Saved test-render.png');
  }
}

main().catch(console.error);
