export const HELP_HTML = `
<p>Passages are written in a light, line-based syntax. Leading spaces never matter. A <b>block</b> ends at a blank line.</p>
<table>
<tr><th>Line</th><th>Meaning</th></tr>
<tr><td># Title</td><td>First line only: the passage title (its ID follows). Optional — edit the heading above the editor instead if you prefer.</td></tr>
<tr><td>## environment<br>## scene<br>## notes<br>## story</td><td><b>Sections.</b> A passage starts in <code>story</code>; a section runs until the next <code>##</code> line. <code>environment</code> is shown in the Environment panel beside the story, <code>scene</code> is the scene card (its first line is the slug, e.g. <code>EXT. CITY GATE — DUSK</code>), <code>notes</code> are for you only and never shown to the player, <code>story</code> returns to the narrative.</td></tr>
<tr><td>### Heading … ######</td><td>Headings inside any section — up to four nested levels: labelled groups in the Environment panel, sub-rows in the scene card, headings in the story.</td></tr>
<tr><td>&gt; text</td><td>Narrative event — what happens right now. Consecutive <code>&gt;</code> lines join.</td></tr>
<tr><td>- Name: text<br>+ Name: text</td><td>Dialogue. <code>-</code> is another character, <code>+</code> is the player. <code>Name:</code> is optional; consecutive lines by the same speaker join.</td></tr>
<tr><td>* label (cond; effect) [target]</td><td>A choice. Consecutive <code>*</code> lines are one group. Inside the parentheses, assignments are <b>effects</b>, everything else is a <b>condition</b> (all must hold). <code>[target]</code> moves to another passage; without it the passage continues.<br><code>* thought: …</code>, <code>* dialogue: …</code>, <code>* action: …</code> record a personality observation.<br><code>* [ ] label</code> makes a multi-select group with a Continue button.</td></tr>
<tr><td>? condition</td><td>The lines that follow (until a blank line or the next <code>?</code>) only appear when the condition is true. There is no else: write <code>? !($done)</code>.</td></tr>
<tr><td>? condition [target]</td><td>Conditional routing: when reached and true, the story jumps to <code>target</code> immediately. Put these at the top of a passage.</td></tr>
<tr><td>[target]</td><td>A link, on its own line or inside text. Match by passage ID, then by exact title. The button shows the target's title. Write <code>\\[</code> for a literal bracket.</td></tr>
<tr><td>$var = value<br>$var += 1</td><td>Assignment on its own line. Creates the variable if needed. <code>$local.x</code> resets whenever a passage is entered; everything else is global.</td></tr>
<tr><td>$var, \${expr}</td><td>Interpolation in any text: <code>Hello, $player.name.</code> or <code>You have \${$gold * 2} coins.</code> Write <code>\\$</code> for a literal dollar.</td></tr>
<tr><td>[?var] [?var:type Label]</td><td>An input bound to a variable. Types: <code>text</code>, <code>number</code>, <code>checkbox</code> (inferred from the current value when omitted). The variable needs a starting value in Variables.</td></tr>
<tr><td>---</td><td>Pause: everything between rules is one message revealed with Next.</td></tr>
<tr><td>@id</td><td>Runs the custom macro <code>id</code> (see Macros). Needs JavaScript approval in the preview.</td></tr>
<tr><td>// text</td><td>Author comment, never shown.</td></tr>
<tr><td>text</td><td>Plain lines are paragraphs with <code>**bold**</code>, <code>*italic*</code> and <code>\`code\`</code>; consecutive lines join, a blank line starts a new paragraph.</td></tr>
</table>
<h3>Example</h3>
<pre># The locked gate

## environment
### Setting
The old city wall, after the rain.
#### Sounds
Dripping water, a distant bell.

## notes
TODO: let the gatekeeper remember the player.

## scene
EXT. CITY GATE — DUSK

## story

&gt; The gate is locked. A slot in the iron waits for a coin.

- Gatekeeper: Evening, $player.name. Got a coin?
+ You: Maybe.

? $player.gold >= 1
* Drop a coin in the slot ($player.gold -= 1) [Courtyard]

? $player.gold < 1
You have no coin.
* dialogue: Could you let me through anyway? ($player.traits.empathy += 1)
* dialogue: Open up, old man. ($player.traits.sarcasm += 1)

---

The gatekeeper shrugs. [Arrival]</pre>
<h3>Expressions</h3>
<p>Literals (<code>1</code>, <code>"text"</code>, <code>true</code>, <code>null</code>, <code>[1, 2]</code>, <code>{"a": 1}</code>), variables, <code>+ - * / %</code>, comparisons, <code>&& || !</code>, parentheses. <code>+</code> joins strings. No function calls.</p>
<h3>State</h3>
<p><b>Variables</b> holds the global state (<code>$player.name</code>, <code>$gold</code>…), trait defaults merged into every actor's <code>traits</code> object, and passage-local defaults (<code>$local.*</code>). Personality choices append to <code>$gameState.observations</code>, which story code can read but not change.</p>
<h3>Preview</h3>
<p><b>Try passage</b> runs the selected passage in the side panel with a copy of the latest runtime state (or the defaults). <b>Live</b> restarts the trial as you edit. <b>Play from start</b> runs the whole story. <b>↶ Undo</b> takes the simulation back one choice, link or input. <b>State</b> shows actors and traits as bars (changes flash with their delta), observations, saved games and JavaScript approval; <b>⤢</b> gives the simulation the whole window (Esc returns). The passage being played glows on the map. Custom JavaScript runs only after <b>Enable JavaScript</b> — trusted authors only.</p>
<h3>Map</h3>
<p>Drag blank space to pan, wheel to zoom, drag cards to move them. Drag the small port on a card's right edge onto another card to insert a link. <b>Auto-layout</b> arranges the current act. Selecting a passage from the list, search or a connection centers it on the map.</p>
<h3>Files</h3>
<p>Projects are folders: <code>story.json</code> + <code>acts/</code> + <code>images/</code>. In Chrome and Edge, <b>Open</b> and <b>Save</b> work directly on your folder or ZIP (the browser asks for permission once per session) and recently opened projects are listed in the File menu; elsewhere, use Download ZIP. </p>
<p><b>Autosave:</b> a draft of your unsaved edits is kept in this browser (IndexedDB) a few seconds after each change and offered for restore the next time the editor opens. It is cleared when you save. It lives only in this browser on this machine — a real Save is still how you keep your work.</p>
`;
