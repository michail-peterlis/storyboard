# Storyline

Open **storyline.html** in a desktop browser. The editor and player are one offline
HTML file with no dependencies, no account and no server.

Version 1.0 is a complete rewrite: a line-based story language, a dark
three-column workspace with a docked live preview and full-window simulation, a
reworked map, one image per passage, autosave, and separate Variables and Macros
windows. There are no runtime dependencies.

## Writing

```text
# The locked gate

## scene
EXT. CITY GATE — DUSK

> The gate is locked. A slot in the iron waits for a coin.

- Gatekeeper: Evening, $player.name. Got a coin?
+ You: Maybe.

? $player.gold >= 1
* Drop a coin in the slot ($player.gold -= 1) [Courtyard]

? $player.gold < 1
You have no coin.
* dialogue: Could you let me through anyway? ($player.traits.empathy += 1)
* dialogue: Open up, old man. ($player.traits.sarcasm += 1)

---

The gatekeeper shrugs. [Arrival]
```

- `# Title` sets the title and ID; `## environment`, `## scene`, `## notes` and
  `## story` are sections (with `###`–`######` headings inside); `> text` is a narrative event; `- Name:` / `+ Name:` are dialogue (other /
  player); `* label (conditions; effects) [target]` are choices; `? condition` gates
  the lines that follow; `? condition [target]` routes; `[target]` links; `$x = 1`
  assigns; `$x` and `${expr}` interpolate; `[?var]` is an input; `---` pauses the
  reveal; `// comment`; `@macro`.
- Autocomplete pops up for `[` (passages), `[?` and `$` (variables) and `@` (macros).
  The toolbar inserts example lines; **?** opens the full reference.
- Diagnostics appear under the editor and as underlines; errors block Play for that
  passage, warnings don't.

Full reference: [docs/language.md](docs/language.md).

## Workspace

- **Map** (left): drag blank space to pan, wheel to zoom, drag cards to move. Cards
  sit on the dot grid, 24 px apart at 100% and coarser when zoomed out; dragging snaps to
  the visible dots, and stories with off-grid positions are shown snapped. Drag
  the port on a card's right edge onto another card to insert a link. **Arrange**
  auto-layouts the current act on the grid (undoable). Selecting a passage from the list, the
  search, a connection or the preview centers it on the map.
- **Editor** (middle): title heading (editable; the ID follows), one image per
  passage with caption, the source editor, diagnostics and connections.
- **Preview** (right, opens with **Try passage** or **Play from start**): the
  sandboxed player. **Live** restarts the trial as you edit and follows the selected
  passage. **↶** undoes the last choice, link or input. **State** shows actors and
  traits as bars (changes flash with their delta), observations, save/load game state,
  export and JavaScript approval. **⤢** runs the simulation in the whole window (Esc
  returns). The passage being played glows on the map.
- **Variables** window: global state, trait defaults and passage locals as rows or
  raw JSON. **Macros** window: custom JavaScript with a code editor.
- File menu: new, open (JSON / ZIP / folder), save (folder or ZIP), download ZIP,
  language reference, light/dark theme. Ctrl+S saves, Ctrl+Z/Y undo/redo.

## Project files

In Chrome/Edge the editor opens and saves your project folder or ZIP in place through the
File System Access API (permission is asked once per session); recent projects are listed
in the File menu. A draft of unsaved edits is autosaved to the browser's IndexedDB and
offered for restore on the next launch; it is cleared on save.

Projects are folders: `story.json` + `acts/` + `images/`; Download ZIP packages the
same layout. Saved games are bound to the story revision. See
[docs/project-format.md](docs/project-format.md).

No story text is stored in the browser; only workspace sizes and the theme are
remembered locally.

**Custom JavaScript is for trusted authors only.** It runs only after explicit
approval, inside a sandboxed frame; see [docs/security-boundary.md](docs/security-boundary.md).

## Development

Node.js 22+. There are no runtime dependencies; esbuild is the only build tool
(resolved from `node_modules`, or from `/opt/npm-tools` when present).

```sh
npm run check          # every module parses; bundles contain no third-party code
npm test               # unit tests (node:test): compiler, runtime, files, layout, regressions
npm run build          # writes storyline.html
npm run test:browser   # Chromium via Playwright, file://storyline.html; screenshots in docs/evidence (git-ignored)
```

Source modules: `model` (schema, undo), `inline` + `compiler` (language),
`expression` + `paths` (values), `runtime` + `render` + `player` (play),
`save` + `bridge` + `session-state` (saves, frame protocol), `zip` + `project-folder`
+ `files-ui` + `storage` (files, autosave, recent handles), `code-editor` + `highlight`
(editor), `map` + `layout` (map), `preview` + `state-view`, `variables-window`,
`macros-window`, `editor` (shell). Do not hand-edit the generated `storyline.html`.

### Verification

`npm run verify` runs all gates: `check` (every module parses; the bundles contain no
third-party code), `test` (compiler syntax and diagnostics, runtime semantics incl.
choice atomicity, redirects, saves, macro approval; file format round trips; layout; ZIP;
regressions from an independent review), `build`, and `test:browser` (Chromium via
Playwright on `file://storyline.html`: editing, autocomplete, drag-to-link, auto-layout,
images, preview with state view/undo/full window, Variables and Macros windows, theme,
ZIP download and reopen, the bundled example, acts, autosave restore). The native file
dialogs (open/save in place, recent projects) need user gestures and are not automated;
only Chromium is run.

Known limitations: nested `?` blocks are not supported; `? cond [target]` discards
narrative emitted earlier in the same passage (a warning flags it); changing an input
after a choice group opened can hide all its options (Restart recovers); the editor has
no code folding or multi-cursor.
