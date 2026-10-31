# Custom JavaScript boundary — implemented, REVIEW PENDING

This is an implementation description and limitations record, **not** an independent
security audit or a claim that hostile JavaScript is safe to execute.

## Boundaries

- Authoring/import/save/compiler never evaluate stored JavaScript. Built-in expressions
  use a tokenizer, parser and interpreter. `new Function` appears only in the player
  entry module; the host embeds that module as static text, not executable project code.
- Every new Play/trial starts an iframe with exactly `sandbox="allow-scripts"` and no
  same-origin, top-navigation, form, popup, download or modal permission. It has an
  opaque origin. It receives one project snapshot and, for a seeded trial, a
  validated copy of Play variables/state/observations. It receives no authoring
  Undo history, other files or handles. The main frame stays attached but hidden
  during a trial; Resume reveals that same frame. At most two frames exist.
- Default custom execution is disabled. Reaching `run` without approval errors.
  An explicit warning/confirmation enables JavaScript for the current in-memory
  project; load/New, explicit language upgrade and any macro-list/code/target change revoke it. Macro edits stop
  both existing frames. Changing approval also destroys both frames before a new
  session starts. Approval cannot be imported or serialized.
- Frame CSP: `default-src 'none'`, `connect-src 'none'`, `img-src data:`,
  `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`;
  inline script/style are allowed for the bundled player. Only approved frames add
  `script-src 'unsafe-eval'` for function-body compilation.
- The host page sets `default-src 'none'` with inline script/style only. It must allow
  `'unsafe-eval'` because `srcdoc` frames inherit the parent policy and a parent eval ban
  could not be relaxed by the trusted frame; the host itself never evaluates project code
  and the frame's own policy withholds eval until approval. Review both policies together.
- Player illustrations resolve stable source IDs to schema-validated embedded
  PNG/JPEG attachments. Remote URLs and SVG remain rejected; image bytes stay
  out of runtime output/saves. Captions and alt text are assigned as text.
- On disk, project files use validated `images/<hash>.png|jpg` references and
  `acts/<name>.json` files. Only a user-selected folder or ZIP supplies those bytes;
  traversal, absolute paths and remote URLs are rejected before asset reads. The
  host validates act schemas/IDs/membership, image dimensions and the entire
  assembled in-memory project before
  sending it to the sandbox. The frame gains no folder handle or file capability.
- Folder writes use content-derived image and act filenames and publish `story.json` last.
  Old assets and act revisions are not removed. A folder containing another project's manifest is
  rejected. ZIP data and large image decoding can still exhaust browser memory.
- There are no runtime dependencies: the editor, syntax highlighting and ZIP handling
  are in-repo. Highlighting escapes all text and never executes story source. No CDN or
  network access is used; the IndexedDB draft and remembered file handles stay in the
  browser profile.
- No project text is interpolated into srcdoc/scripts. The frame's document contains
  only static runtime/CSS and a generated CSP. Project data travels by structured
  `postMessage` after the frame's ready handshake.

## Bridge protocol 1

The frame name carries a fresh random session UUID. The host requires `event.source`
to be the active frame or the retained main Play frame, with matching
protocol/session, exact message keys and bounded JSON encoding. Only the active
frame updates displayed debug/diagnostic data or supplies a requested save.
The frame requires the source to be `parent`, matching identity and
one valid init; it validates the project schema again. The opaque `"null"` origin
is not used as authentication. Old frames and repeated initialization are rejected.

Host-to-frame: one init with protocol/session/kind, project, start ID, approval
boolean and optional validated trial state. Project artwork and this init envelope
have no byte cap; the project schema is still validated by the player. Runtime
commands and save checkpoints retain their 5 MiB envelope budget. Frame-to-host:
ready, string diagnostic, or variable/state debug data with passage ID. Ordinary
messages retain a 1 MiB budget; global/local debug uses 2 MiB plus envelope overhead
because each state scope has its own 1 MiB budget. Oversized incoming
messages are ignored; an oversized outgoing debug snapshot produces a small explicit
diagnostic. Debug/diagnostics update text-only inspection UI. No message can mutate
project data, write files, supply a file handle or execute host commands.

A trusted macro can forge player diagnostic/debug messages: the session is a routing
identity, not a credential hidden from frame code. The host limits the capabilities
of such messages; it does not authenticate the truth of arbitrary macro output.

## Runtime and rendering

The only supported macro API is synchronous, frozen `ctx.get/set/text/link`. Scalar
validation, declared destinations, output/operation budgets, expired capabilities and
Promise rejection protect that API's contract. Entry state and API output are buffered;
exceptions/rendering errors roll them back. No built-in node is converted to arbitrary
HTML. Markdown tokens are consumed by an allowlist DOM renderer using element/text
creation; dynamic text, labels and values are never reparsed as source.

Paragraph reveal is a presentation mechanism, not confidentiality/access control. The
full passage evaluates and its detached DOM passes budgets before entry commits; reveal
only unhides existing blocks and does not execute source/macros again. The frame already
contains the complete project and output. Hidden controls are unavailable through normal
UI navigation, not inaccessible to arbitrary approved frame code. Built-in v2 variable
creation remains scalar/name/count/size bounded and transaction-local.

## Known limits / review gates

- Arbitrary JS still has browser globals. It can alter its own DOM, lie in debug data,
  allocate memory, attempt self-navigation/exfiltration, or loop forever. CSP/sandbox
  are not a complete exfiltration policy. No intentional infinite-loop tests ran.
- Synchronous iframe execution can block the tab/main thread. Recreating a frame is
  normal reset behavior, not a guaranteed hard timeout or recovery mechanism.
- API operation budgets do not count arbitrary JS instructions. Expired capabilities
  do not prevent unrelated timers/global side effects. Rollback is not rollback of
  arbitrary JavaScript side effects.
- Hiding the retained Play frame preserves its DOM/runtime; it does not suspend
  approved custom-code timers. Revoking approval destroys both main and trial
  frames. Uncapped embedded artwork can exhaust available browser memory.
- Headless automated tests cover parent DOM denial, absence of extra sandbox flags,
  no normal app network requests, inert built-in output, bridge filtering, trust and
  API failure paths. They do not establish complete containment, accessibility,
  browser-policy uniformity, or production safety.
- Independent security/implementation review is REQUIRED. If hostile-code execution
  or hard CPU limits are requested, this architecture must be reconsidered (for example
  a terminable worker plus a separately reviewed policy), not silently rebranded safe.
