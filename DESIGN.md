# Live Markdown — Editor Design

Status: proposed implementation design  
Date: October 3, 2026  
Priorities, in order: simple to use, fast while typing, easy to customize.

## Product intent

When the extension is enabled, clicking a Markdown file opens an editable, rendered document that fills the editor pane. The user clicks into the document and types directly. Headings look like headings, emphasis looks emphasized, and lists look like lists as the document changes.

The experience uses one editing surface. Formatting syntax appears where the user is editing and recedes elsewhere. The saved file stays ordinary Markdown, preserving its existing syntax and formatting choices.

The default should feel like opening a document, not launching a separate tool. No preview command, second pane, or onboarding wizard is required.

## Design principles

| Priority | Decision | User benefit |
| --- | --- | --- |
| Simple | Open directly into one rendered editor | Click a file and start writing |
| Fast | Incremental parsing and targeted decorations | Immediate typing and stable selection |
| Customizable | VS Code theme inheritance, typography, and syntax visibility settings | Adapt the editor through familiar settings |
| Predictable | Keep Markdown source as the document model | Editing and rendering do not rewrite the file |

## Opening files

Register a custom text editor with view type `liveMarkdown.liveEditor`, display name **Live Markdown**, selectors for `*.md`, `*.markdown`, and `*.mdown`, and priority `default`. This requests automatic use for matching files. VS Code can prompt when multiple custom editors compete, and explicit user editor associations take precedence. [Custom editor registration](https://code.visualstudio.com/api/extension-guides/custom-editors)

The intended steady state is: select a Markdown file in Explorer, and Live Markdown occupies its normal editor tab. Honor existing overrides rather than changing them silently. When needed, the user can select Live Markdown through **Reopen Editor With…** and set it as their default.

Example explicit association:

```json
{
  "workbench.editorAssociations": {
    "*.md": "liveMarkdown.liveEditor",
    "*.markdown": "liveMarkdown.liveEditor",
    "*.mdown": "liveMarkdown.liveEditor"
  }
}
```

Do not claim `.mdx` support. An extension command can create an untitled Markdown document and open it in the custom editor; untitled routing must be verified during implementation. Disabling the extension restores VS Code's available editors. **Open in Text Editor** provides an escape hatch for any file.

## Editing experience

### One pane

```text
┌────────────────────────────────────────────────────────────┐
│ README.md                                  [Source] [Style]│
│                                                            │
│      Getting started                                       │
│      ──────────────────────────────────────                │
│                                                            │
│      Write clearly and keep things simple.                 │
│                                                            │
│      • Simple                                              │
│      • Fast                                                │
│      - **Customizable|**       ← currently being edited     │
│                                                            │
│      Everything in this pane belongs to the same document. │
└────────────────────────────────────────────────────────────┘
```

The sketch shows source markers on the active line; bold text remains styled while those markers are visible. The cursor belongs to the document itself. Other lines retain their rendered appearance.

Use a readable column within the full editor pane, with an optional full-width setting. The tab stays an ordinary document tab. Source and style actions live in the editor title menu. No persistent formatting toolbar in the first release.

### Syntax reveal

Default behavior: reveal Markdown markers on the active line while retaining its text styling. For a multiline construct such as a table or image widget, reveal the relevant block when the cursor enters it. A selection reveals markers across all selected ranges so copying and deleting have predictable source positions.

For example, `# Getting started` displays as a large heading. Clicking into it reveals the `# ` marker while the heading keeps its size. `**important**` appears bold; its delimiters become visible on the active line. Moving away hides the delimiters again.

Revealing syntax changes presentation only. It never inserts or deletes source characters. Preserve the scroll anchor when syntax reveal changes wrapping, and avoid animations that move the caret. Invalid or unfinished constructs remain editable text until they can be rendered confidently.

### Direct interaction rules

| Content | Reading appearance | Editing behavior |
| --- | --- | --- |
| Headings | Heading typography | Click text to position the caret; reveal heading marker on the active line |
| Emphasis / inline code | Styled text | Type directly; reveal delimiters on the active line |
| Lists / blockquotes | Bullets, numbering, quote border | Reveal markers on the active line; Enter continues the structure, and Enter on an empty item exits it |
| Task lists | Checkbox and text | Clicking the checkbox changes only `[ ]` / `[x]`; typing edits the item text |
| Links | Styled link label | Ordinary click edits; Ctrl/Cmd-click follows the destination |
| Images | Inline image with alt text | Click or keyboard navigation reveals the exact image syntax for editing |
| Fenced code | Monospace block | Edit code directly; reveal fence lines when entering the block |
| Tables | Rendered table while inactive | Entering the table reveals editable Markdown rows in the same pane |
| Raw HTML / unknown syntax | Literal source | Editable without executing or stripping it |

A rendered table is a display widget for its source range. Cell-by-cell table editing is a later feature. Widgets must provide deterministic click-to-source mapping and keyboard entry/exit; they cannot become inaccessible islands.

Support ordinary typing, selection, cut/copy/paste, drag selection, find/replace, and common navigation keys. Plain-text clipboard content is Markdown source, including delimiters; copying never silently converts a selection to HTML. Pasted Markdown is inserted unchanged. Defer importing rich HTML from the clipboard.

Formatting commands for bold, italic, inline code, and links apply minimal Markdown edits around the selection. Enter and Backspace behavior must handle nested lists predictably. IME composition, dead keys, and Unicode input are release requirements; decoration updates cannot interrupt composition.

## First release scope

Include direct editing with live rendering for headings, paragraphs, emphasis, inline and fenced code, blockquotes, ordered/unordered lists, task lists, links, local images, tables, and strikethrough. Describe this as a documented Markdown dialect rather than promising complete GitHub visual parity.

Include default file opening, an in-place source toggle, normal saving and document dirty state, undo/redo integration, keyboard access, theme inheritance, reading presets, typography controls, and optional local CSS.

Defer Mermaid, math, exports, executable content, image uploads, rich clipboard import, arbitrary renderer plugins, cell-by-cell table editing, and advanced syntax highlighting. Document the compatibility limits of a custom editor: native editor decorations, minimap, and other extensions' editing commands are not automatically available inside it.

Initial target: VS Code desktop on macOS, Windows, and Linux, plus remote workspaces using URI-based file access. Choose and test the minimum supported VS Code version during implementation. Browser-hosted VS Code is a later compatibility milestone.

## Architecture

Use TypeScript and a `CustomTextEditorProvider` hosting a CodeMirror 6 editing surface. The provider receives a VS Code `TextDocument` and a webview for that file. Commit minimal changes through `WorkspaceEdit`; observe document events to receive changes from undo, revert, and other editors. VS Code owns the text document lifecycle. [Custom text editor model](https://code.visualstudio.com/api/extension-guides/custom-editors)

Inside the webview, use CodeMirror's Markdown language support, incremental syntax tree, marks, replacement decorations, and widgets. Its document contains the actual Markdown text; rendering is a projection over source ranges. Decorations can style text, hide ranges, and insert widgets. Decorations that affect vertical layout must be supplied through the appropriate direct decoration mechanism. [CodeMirror decorations](https://github.com/codemirror/website/blob/main/site/examples/decoration/index.md), [CodeMirror system guide](https://codemirror.net/docs/guide/)

Build rendering rules from the syntax tree rather than converting HTML back into Markdown. Start without a separate full-document HTML parser, worker pipeline, or UI framework. Add those only if a measured requirement justifies them.

```text
VS Code TextDocument  ← minimal edits →  DocumentBridge
        │                                     │
        │ save / undo / external changes      │ versioned messages
        ▼                                     ▼
    Markdown file                    CodeMirror source buffer
                                              │ incremental syntax tree
                                              ▼
                                   marks + widgets + syntax reveal
                                              │
                                              ▼
                                    editable rendered document
```

### Document synchronization

The host `TextDocument` is the authoritative committed model. The webview mirrors it and displays local input immediately. This makes synchronization an editing requirement, not just a rendering concern.

1. Assign each view a session ID. Local transactions contain an operation ID, base document version, and changed source ranges. Send edits immediately; cosmetic rendering delays must never delay document commits.
2. Keep one host edit in flight per document and an ordered local queue. Compose queued changes against the acknowledged model before the next submission. Never discard an edit because a newer render exists.
3. The host checks document identity, base version, range bounds, and edit permissions, then applies minimal replacements. Preserve line endings through an explicit offset mapping: CodeMirror's normalized line positions must not be treated as raw CRLF offsets.
4. Match the resulting document event to the submitted operation. Acknowledge it once and update the mirrored version. Applying host changes to the local buffer must not emit a second local edit.
5. Deliver changes from native text editors, undo/redo, formatters, file reloads, or another view as external transactions. Map selection and pending operations across nonconflicting changes. If an overlap cannot be resolved safely, preserve the local draft, stop committing it, and offer explicit recovery; never overwrite either version silently.
6. Serialize Save, Undo, Redo, and source-mode transitions behind acknowledged local edits. Failed edits stay recoverable and expose an inline status. No automatic reopening or reset may erase a pending draft.
7. Suspend decoration and image work in hidden tabs while continuing required document synchronization. Restore from the latest host version and mapped selection when shown.

Use host-backed undo as the sole committed history; do not install a competing CodeMirror history stack. Route custom-editor shortcuts and command invocations to host undo/redo after pending edits commit. Cursor restoration and useful edit grouping require integration tests; `WorkspaceEdit` does not by itself prove native-feeling undo behavior. Implement and validate that path before polishing rendering.

Use bounded queues and stop accepting further mutations with a recoverable error if synchronization stalls. Do not silently drop keystrokes or fall back to whole-file replacement. Pending edits around immediate close, hide, Save, and extension-host interruption are a release-blocking prototype concern: prove they are committed or recoverable before shipping. Retaining a hidden webview can preserve local state, but is not a substitute for document synchronization or durable recovery.

Multiple tabs belong to their own documents. If the same file is opened in split editors, share one host bridge and serialize edits across views; selection and scroll remain per view. Version conflicts follow the same recovery policy. Enabling multiple views is contingent on passing the synchronization tests.

### Rendering and selection

Map decoration ranges through document changes, then recompute affected syntax regions. Build expensive inline decorations around the visible viewport with a modest margin; maintain layout-changing block decorations through direct state-backed ranges. Invalidate dependent link/image references when definitions change elsewhere in the file.

Style editable text with marks and line decorations. Hide only structural markers outside active/selected regions. Construct images, checkboxes, and table widgets from parsed data with safe DOM APIs. Cache widget identity by source range and content, and reuse unchanged elements.

Keep document positions independent of presentation. Cursor movement into a hidden source range reveals it before editing. Selection across widgets exposes the source as needed. During composition, defer structural decoration changes until composition ends. If rendering fails, keep the text buffer editable and show source in the same pane.

### Module boundaries

| Module | Responsibility |
| --- | --- |
| `extension.ts` | Custom editor contribution and command registration |
| `markdownEditorProvider.ts` | Resolve each document's webview and manage lifecycle |
| `documentBridge.ts` | Versioned edits, acknowledgments, external changes, and recovery |
| `configuration.ts` | Document-specific settings and reading presets |
| `resources.ts` | Image/link resolution, trust checks, and stylesheet handling |
| `webview/editor.ts` | CodeMirror setup, keymaps, source toggle, and focus |
| `webview/liveRendering.ts` | Syntax-derived decorations and active-range reveal |
| `webview/widgets.ts` | Images, checkboxes, tables, and source-position mapping |
| `webview/theme.css` | Theme variables, typography, responsive width, and focus |

Use a typed message protocol for readiness, edits, acknowledgments, external changes, resource resolution, and explicit editor actions. Validate messages on both sides. Keep the VS Code API object private in the webview. Dispose listeners, resource watchers, and editor instances when their view closes. [Webview guidance](https://code.visualstudio.com/api/extension-guides/webview)

## Customization

Read `liveMarkdown` settings for the edited document, respecting VS Code precedence and multi-root workspaces. Apply appearance changes without reconstructing the editor or changing the file.

| Setting | Default | Values / behavior |
| --- | --- | --- |
| `syntaxVisibility` | `"activeLine"` | `activeLine`, `activeBlock`, `always`; selection and composition always reveal necessary source |
| `readingPreset` | `"default"` | `default`, `compact`, `comfortable` |
| `fontFamily` | `"inherit"` | VS Code UI font, or a local font-family list |
| `fontSize` | `null` | Preset value, or 10–32 CSS pixels |
| `lineHeight` | `null` | Preset value, or unitless 1.2–2.2 |
| `contentWidth` | `null` | Preset value, 40–120 `ch`, or `"full"` |
| `showLineNumbers` | `false` | Display source line numbers when enabled |
| `renderImages` | `true` | Render permitted images as widgets |
| `renderTables` | `true` | Render inactive tables as widgets |
| `customCss` | `""` | One local stylesheet path |
| `allowRemoteImages` | `false` | Permit HTTPS images in trusted workspaces |

Preset values: default = 16 px / 1.6 line height / 80 ch; compact = 14 px / 1.45 / 100 ch; comfortable = 18 px / 1.75 / 72 ch. Explicit values override preset defaults. Keep code monospace and inherit light/dark/high contrast colors from VS Code.

```json
{
  "liveMarkdown.syntaxVisibility": "activeLine",
  "liveMarkdown.readingPreset": "comfortable",
  "liveMarkdown.contentWidth": "full",
  "liveMarkdown.showLineNumbers": false
}
```

**Toggle Source Mode** reveals all source in the same editor while preserving selection, scroll, pending edits, and host history. It is distinct from **Open in Text Editor**, which hands the document back to VS Code's native editor after synchronization completes.

Commands: Toggle Source Mode, Open in Text Editor, Choose Reading Preset, Open Settings, Reset Appearance, Bold, Italic, Inline Code, and Insert Link. Scope editor keybindings to the active Live Markdown webview. Configuration commands use the scope explicitly selected by the user.

Custom CSS loads last and targets documented presentation classes and variables. Keep editor position measurement, input mechanics, and widget event handling outside the supported customization contract. Invalid or harmful CSS can be disabled with Reset Appearance from the title menu even if the document is difficult to interact with.

Relative CSS paths resolve from the containing workspace folder, or the document directory for standalone files. Support absolute local paths from explicit user settings. Watch only the chosen stylesheet, cap it at 256 KiB, and retain the last valid appearance on a read failure. Disable workspace-provided CSS in Restricted Mode; block remote styles and CSS imports.

## Performance targets

These are proposed release gates, not measured results. Measure a release build on a documented reference laptop, with other extensions disabled. Benchmark against ordinary source editing for input latency.

| Measurement | Target |
| --- | --- |
| Open-to-editable first paint, 100 KiB document | ≤ 500 ms p95 |
| Keystroke-to-local-text paint, 100 KiB document | ≤ 16 ms p95 |
| Updated visible formatting, 100 KiB document | ≤ 50 ms p95 |
| Local edit acknowledgment | ≤ 100 ms p95 locally; report remote latency separately |
| Extension-host edit processing | ≤ 5 ms p95, excluding API/message wait |
| Main-thread task while typing | No task longer than 50 ms in representative fixtures |
| Hidden editor | No recurring decoration work or image polling |

Collect at least 100 editing samples per fixture. Include long paragraphs, nested lists, tables, images, reference definitions, Unicode, and large paste operations. Measure text paint, formatting paint, and host acknowledgment separately. Test cold and warm opens, many open tabs, hidden editors, and remote round trips. Record memory and package size before release and use measurements to set defensible limits.

Above 1 MiB or 20,000 lines, reduce expensive widgets and decoration density while keeping text editable. Above 5 MiB, open in source mode with a compact explanation. These initial thresholds need benchmark validation. Never switch to manual refresh for an editable document; rendering can simplify while typing and saving continue.

## Content, accessibility, and recovery

Treat Markdown as inert content. Raw HTML stays literal, scripts never run, and link handling blocks command/script schemes. Ordinary link clicks edit text; deliberate follow actions permit HTTP(S), heading anchors, and validated document-relative file links.

Resolve images through the host against the document URI. Limit local resources to approved extension assets and the containing workspace folder or standalone document directory. Validate containment and restrict webview resource roots. Use URI operations and `workspace.fs` for remote compatibility. Show alt text for unavailable or blocked images.

Use a restrictive content security policy with nonce-authorized bundled code and styles. Enable external HTTPS images only through the explicit setting in a trusted workspace. Workspace CSS cannot loosen the policy. [Webview security](https://code.visualstudio.com/api/extension-guides/webview)

Restricted Mode keeps editing available while disabling workspace CSS and remote images. Rebuild the resource policy when trust changes. No accounts, telemetry, or remote rendering service are required. [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)

Provide visible keyboard focus, accessible widget labels, high contrast styling, reduced-motion behavior, and a keyboard path into every rendered construct. Screen readers must be able to read and edit source with syntax always visible; verify the rendered mode rather than assuming CodeMirror support covers custom widgets. Do not announce the whole document after each edit.

Rendering failure exposes editable source in place. Synchronization failure preserves the draft and requires recovery before overwriting committed content. Distinguish these failures in the UI. Rename, Save As, revert, dirty-file reload, readonly resources, and unavailable remote providers must be tested. Logs omit document contents and full local paths.

## Delivery and acceptance

1. **Editing foundation:** prototype default file opening, a CodeMirror buffer, minimal host edits, save/auto-save, undo/redo, and external changes. Resolve pending-input recovery and offset mapping before adding rendering.
2. **Live rendering:** add headings, emphasis, lists, code, syntax reveal, and selection mapping. Exit when direct mouse and keyboard editing works without caret jumps or source changes caused by rendering.
3. **Widgets and appearance:** add task toggles, links, images, tables, presets, and settings. Verify composition, keyboard access, theme changes, and high contrast behavior.
4. **Release readiness:** run performance and synchronization tests across supported VS Code versions, desktop platforms, and a remote workspace. Package a VSIX with a concise README and documented compatibility limits.

Required integration checks include rapid typing during a delayed host acknowledgment; overlapping external edits; undo/redo after formatting and checkbox toggles; save immediately after typing; auto-save; hide or close immediately after input; restore after host interruption; CRLF and surrogate-pair offsets; source-mode transitions; same-document split views; readonly files; and no-op rendering that leaves file bytes unchanged.

Required interaction checks include clicking styled words; navigating into hidden delimiters; selecting across widgets; copy/paste source fidelity; IME composition; list continuation and exit; table editing; image resizing above the caret; changing settings without losing selection; find/replace; and opening a file through Explorer with the default association.

The first release succeeds when opening a Markdown file immediately gives the user one rendered editing pane, typing feels responsive, and the file remains dependable plain Markdown.
