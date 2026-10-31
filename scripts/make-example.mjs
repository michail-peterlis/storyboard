// Writes examples/city-gate.zip: the starter story plus a second act.
import { mkdir, writeFile } from 'node:fs/promises';
import { newProject, validateProject } from '../src/model.js';
import { addAct } from '../src/acts.js';
import { createProjectZip } from '../src/project-folder.js';
const project = newProject();
project.title = 'The City Gate';
const entry = addAct(project, 'Act 2 — Inside');
const opening = project.passages.find(p => p.id === entry);
opening.title = 'Market square'; opening.id = 'Market_square'; opening.source = `# Market square

## scene
INT. MARKET SQUARE — NIGHT

## story

> Stalls are shuttered. A single lantern still burns.

? $player.gold >= 2
- Merchant: Two coins and the lantern is yours.
* Buy the lantern ($player.gold -= 2; $player.lantern = true)
* Keep walking

? $player.gold < 2
- Merchant: Come back when you have two coins.

---

? $player.lantern == true
The lantern throws long shadows. [Arrival]

? $player.lantern != true
You move on in the dark. [Arrival]`;
const act = project.editor.actLayout.acts.find(a => a.passageIds.includes(entry));
act.passageIds = [opening.id]; act.startPassageId = opening.id;
project.passages.find(p => p.id === 'Courtyard').source += `\n\n* Head for the market [Market_square]`;
project.initialGameState.player.lantern = false;
validateProject(project);
await mkdir('examples', { recursive: true });
await writeFile('examples/city-gate.zip', await createProjectZip(project));
console.log('Wrote examples/city-gate.zip');
