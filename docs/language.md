# Storyline language

A line-based syntax for passages (`languageVersion: 1`). File layout: `docs/project-format.md`.

## Lines and blocks

- Leading whitespace is ignored on every line (indent freely).
- A **block** is a run of non-blank lines. Most blocks end at a blank line.
- The first non-blank, non-comment line may be `# Title`.

| Line | Meaning |
|---|---|
| `# Title` | Passage title. The passage ID follows the title (`Title`, `Title_2`, …); renaming rewrites every link to the passage. Omit it to keep the title shown above the editor. |
| `## environment` / `## scene` / `## notes` / `## story` | **Sections** (level 2). A passage starts in `story`; a section runs until the next `##` line or the end of the passage. `environment` → Environment panel above the story; `scene` → scene card (first plain line is the slug shown in the header); `notes` → author-only, never rendered; `story` → back to the narrative. Only text, `###`–`######` headings and `?` conditions may appear in `environment`/`scene`. A `##` with any other name is a warning. |
| `### …` to `###### …` | Headings (levels 3–6) inside any section: nested labelled groups in the Environment panel, sub-rows in the scene card, headings in the story. With `#` (title) and `##` (section) that makes six levels. |
| `> text` | Narrative event. Consecutive `>` lines form one block (rendered italic). |
| `- Name: text` / `+ Name: text` | Dialogue line. `-` other character, `+` the player. `Name:` is optional; consecutive lines of the same speaker and side join. Escape a literal colon in a name with `\:`. |
| `* label (items) [target]` | Choice; consecutive `*` lines are one group. Items are separated by `;`: assignments are effects, anything else is a condition (all must be true). `[target]` navigates; without it the passage continues after the group. `* thought: …`, `* dialogue: …`, `* action: …` set the personality type recorded in observations; a group must share one type. `* [ ] label` (or `[x]`) makes a multi-select group with a Continue button; its options must share one target or all continue locally. |
| `? condition` | Conditional block: the following lines until a blank line, a `---`, or the next `?` are included only when the condition is true. No else form; negate the condition. Conditions cannot nest. |
| `? condition [target]` | Conditional routing: when execution reaches the line and the condition is true, the story enters `target` immediately (locals reset, globals carried). Output emitted earlier in the same passage is discarded; a warning flags that. At most 32 chained jumps. |
| `[target]` | Link (own line or inline). Resolution: exact passage ID, then exact title, then case-insensitive title. Ambiguous titles are errors — use the ID. The button label is the target's title. |
| `$path = expr` / `+=` / `-=` | Assignment statement on its own line. Creates missing globals and `$local.*` values. `+=`/`-=` need existing numbers. |
| `$path`, `${expr}` | Interpolation inside any text (paragraphs, events, dialogue, scene, environment, choice labels). `\$` is a literal dollar. `$name.` at the end of a sentence works: the trailing dot is text. |
| `[?var]`, `[?var:type]`, `[?var:type Label]` | Input bound to `$var` (type `text`, `number`, `checkbox`; inferred from the current value when omitted). The variable needs a starting value. Changing the input updates state immediately. |
| `---` | Reveal pause. Everything between rules is one message; **Next** reveals the following one. Without rules a passage is one message. |
| `// text` | Author comment (whole line). Inline `//` is ordinary text. |
| `@id` | Run custom macro `id`. Needs JavaScript approval in the preview. |
| other | Paragraph with `**strong**`, `*em*` / `_em_`, `` `code` ``. Backslash escapes any character. |

Inside a `? condition` block you can use any other line kind except another `?` or
`---`, including a `## environment` switch: the section change is scoped to the block.
Choices inside the block take the block condition as part of their edge label.

Recommended structure for a passage:

```text
# Title
## environment        context for the reader's side panel
### Setting           (free-form headings; nest with #### … ######)
### Mood
## notes              design notes, TODOs — never shown to the player
## scene
EXT. PLACE — TIME     the slug line
### Time of day       optional sub-rows
## story              the narrative: events, dialogue, choices
```

## Expressions

Literals: numbers, `"double"` or `'single'` quoted strings, `true`, `false`, `null`,
`[list]`, `{"key": value}`. Variables: `$name`, `$a.b`, `$a[0]`, `$a["key"]`.
Operators: `+ - * / %` (`+` concatenates when either side is a string), `== !=`,
`< <= > >=`, `&& || !`, parentheses. No function calls, no implicit coercion
(`$count > "1"` is an error).

## State

- Bare `$paths` are global and live in `$gameState`; `$gameState.x` and `$x` are the
  same value. Globals persist for the whole play session.
- `$local.*` resets from the passage-local defaults on every passage entry and
  survives in-passage choices.
- The **Variables** window edits the global defaults, the trait defaults (merged into
  every actor that has a `traits` object) and the local defaults.
- `$gameState.observations` is runtime-managed: every committed choice appends a
  record `{sequence, timestamp, type, passage, choice, changes}`; story code can read
  but not assign it.
- Reading a variable that has no value is an error at play time; the editor warns
  when a variable is neither in Variables nor assigned anywhere in the project.

## Execution model

Entering a passage runs its lines in order: assignments and macros execute, text is
collected, and a choice group pauses execution. Choosing applies the chosen options'
effects in order, appends observations, marks the group as answered and resumes
after the group (or enters the target). The whole step is atomic: a failing
effect or destination leaves the previous state and the open group intact.

The reader shows one message (segment) at a time; **Show passage** shows every
revealed segment, **Focus current** returns to the latest. Revealing never executes
anything.

## Macros

Custom JavaScript runs only after **Enable JavaScript** in the preview, inside the
sandboxed player frame. The function body receives `ctx`:

- `ctx.get(path)` — copy of a value (`'player.gold'`, `'local.note'`)
- `ctx.has(path)` — whether a value exists
- `ctx.set(path, value)` — assign (JSON values only)
- `ctx.text(string)` — emit a paragraph
- `ctx.link(label, passageId)` — emit a link to a passage declared in the macro's
  target list (so the map can show the edge)

Synchronous only; a returned promise is an error. See `docs/security-boundary.md`.

## Diagnostics

Errors block Play for that passage and are listed with line:column; warnings
(unknown variables, empty blocks, routing after content) do not block. Both are
underlined in the editor.
