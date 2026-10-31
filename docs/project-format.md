# Project files

A project is a folder (or a ZIP of that folder):

```
story.json          overview: settings, start passage, acts, passage order
acts/<id>-<hash>.json   one file per act: its passages and map viewport
images/<sha256>.png|jpg  image bytes, content-addressed (shared when identical)
```

## story.json (overview)

```json
{
  "format": "storyline-project", "formatVersion": 1,
  "languageVersion": 1, "macroApiVersion": 1,
  "id": "project_…", "title": "…", "startPassageId": "Arrival",
  "initialVariables": { },          "// passage-local defaults ($local.*)"
  "initialGameState": { "player": { "traits": {} } },
  "traitDefaults": { "empathy": 0 },
  "customMacros": [ { "id": "awardCoin", "code": "…", "targets": [] } ],
  "editor": { "viewport": { "x": 0, "y": 0, "zoom": 1 } },
  "passageOrder": ["Arrival", "…"],
  "acts": [ { "id": "act_1", "title": "Act 1", "startPassageId": "Arrival", "path": "acts/act_1-….json" } ]
}
```

## Act file

```json
{ "format": "storyline-act", "formatVersion": 1, "id": "act_1",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "passages": [ { "id": "Arrival", "title": "Arrival", "position": { "x": 80, "y": 120 }, "source": "# Arrival\n…",
                  "image": { "id": "image_…", "name": "gate.png", "caption": "", "width": 1200, "height": 800, "path": "images/<sha256>.png" } } ] }
```

`image` is optional: one image per passage, shown when the passage starts. Act files
and images are written content-addressed, so a save never overwrites a file that an
older overview still references; the overview is written last.

## Working model (in memory)

Same fields, with `passages` inline (each with `image.dataUrl` instead of `path`) and
`editor.actLayout` instead of `acts`/`passageOrder`. `validateProject` in `src/model.js`
is the authoritative schema; unknown fields are rejected.

## Saved games

`{ "format": "storyline-save", "formatVersion": 1, … }` with the passage, global and
local state, rendered output, environment, scene, continuation paths and the pending
choice. A save is bound to the story revision (`storyKey`) and is validated against
the compiled passage before restore.

## Compatibility

`formatVersion`, `languageVersion`, act and save versions are checked exactly; anything
else is rejected with a clear error. Bump a version when its schema changes incompatibly.
