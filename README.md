# Live Markdown

Live Markdown is a VS Code custom text editor for editing Markdown in one rendered pane. Markdown remains the document model: the webview edits source ranges and VS Code owns saving and document versions.

## Use

Open a `.md`, `.markdown`, or `.mdown` file. If VS Code has another editor association or custom editor for that extension, choose **Reopen Editor With… → Live Markdown** and optionally set it as the default. Use **Open in Text Editor** to return to VS Code's source editor. **Live Markdown: New Document** creates an untitled Markdown document.

The title menu provides source visibility, reading presets, settings, appearance reset, undo/redo, and the source-editor escape hatch. Choose Reading Preset and Reset Appearance ask which workspace, workspace-folder, or user settings scope to update. Bold, italic, undo, and redo shortcuts are scoped to this editor. A bounded host-side journal applies undo/redo as source-range edits to the shared VS Code document; CodeMirror does not keep a competing history stack. Consecutive character typing and backspaces from one view group into one undo step.

## Rendering

The current dialect styles ATX and Setext headings, emphasis, inline code, strikethrough, links, fenced code, and blockquotes. Syntax markers recede away from the active line and selection. When VS Code's `editor.accessibilitySupport` is explicitly set to `on`, syntax stays visible throughout the document. Raw HTML remains literal. Task markers render as accessible checkboxes, inactive tables render as accessible table widgets, and inline or reference-style local images can render when permitted. Unavailable or blocked images display their alt text. Table cells map to their source row when activated; Enter or F2 on a table link edits its source row, while Ctrl/Cmd-click or Ctrl/Cmd+Enter follows it. Ctrl/Cmd-click follows HTTP(S) and permitted document-relative links, including reference-style links whose definitions appear elsewhere; same-document heading anchors stay in the editor.

This is a documented Markdown dialect; it does not promise full GitHub visual parity. VS Code native editor decorations, minimap, and editing commands from other extensions are not automatically available inside the custom editor. Use **Open in Text Editor** when a native editor feature is needed.

If a rendering rule fails, the editor drops its decorations, shows a status message, and leaves the Markdown source editable.

For documents above 1 MiB or 20,000 lines, expensive image and table widgets are simplified while editing remains enabled. Documents above 5 MiB open in source mode with a brief explanation.

Individual tables larger than 16,000 characters or 200 lines remain visible as editable Markdown source, and at most 16 image widgets render in the visible region at once. These limits keep dense blocks responsive even when the overall document is below the large-document thresholds.

Same-document split views share a document bridge and keep selection and scroll state per view. Disjoint pending edits are rebased over host changes; overlapping edits become recoverable draft conflicts. Unacknowledged source patches are journaled per webview in VS Code workspace state, with bounded size and explicit copy/reload recovery.

## Settings

Settings are read for the edited document and support VS Code configuration precedence:

- `liveMarkdown.syntaxVisibility`: `activeLine` (default), `activeBlock`, or `always`.
- `liveMarkdown.readingPreset`: `default`, `compact`, or `comfortable`.
- `liveMarkdown.fontFamily`, `fontSize` (10–32), `lineHeight` (1.2–2.2), and `contentWidth` (40–120, `full`, or preset default).
- `liveMarkdown.showLineNumbers`, `renderImages`, `renderTables`, and `allowRemoteImages`.
- `liveMarkdown.customCss`: a local stylesheet path. Workspace CSS is disabled in Restricted Mode; an absolute user-level stylesheet remains available, including Windows drive and UNC paths. Styles are size limited and CSS imports are removed.

Live Markdown remains available for editing in Restricted Mode. Workspace CSS and remote images stay disabled until the workspace is trusted.

### Custom CSS surface

Custom stylesheets load after the built-in theme. The supported theme variables are `--lm-fg`, `--lm-bg`, `--lm-muted`, `--lm-border`, `--lm-link`, `--lm-code-bg`, `--lm-font-family`, `--lm-font-size`, `--lm-line-height`, and `--lm-content-width`. Presentation classes include `.lm-heading` and `.lm-heading-1` through `.lm-heading-6`, `.lm-strong`, `.lm-emphasis`, `.lm-inline-code`, `.lm-strike`, `.lm-link`, `.lm-entity`, `.lm-code-line`, `.lm-blockquote`, `.lm-list-marker`, `.lm-image-source`, `.lm-task-widget`, `.lm-table-widget`, `.lm-image-widget`, `.lm-status`, `.lm-recovery`, and `.lm-recovery-source`.

For example, a stylesheet can set `:root { --lm-link: #8b5cf6; }`, set `.cm-editor { --lm-font-size: 20px; }`, or style `.lm-blockquote { border-left-width: 5px; }`. Custom CSS loads after the appearance settings, so these rules can override them. The customization contract covers presentation only; editor positioning, input behavior, and widget event handling are internal. Use **Reset Appearance** in the editor title menu if custom styles make the document hard to read.

For screen-reader editing, set `editor.accessibilitySupport` to `on` or `liveMarkdown.syntaxVisibility` to `always`. Both keep Markdown source markers exposed and avoid replacing task lists, tables, and images with widgets. In rendered mode, Tab moves from the editor into the next task, table, or image widget; Enter or F2 enters a table row's source, and Escape returns from the table to the editor.

Local images are limited to files below the document's workspace folder, or the document directory for a standalone file. HTTPS images require a trusted workspace and `allowRemoteImages`. Raw HTML and script content are never executed.

## Development

```sh
npm install
npm run build
```

Open this folder in VS Code and press F5 to launch the Extension Development Host. The automated Extension Host suite covers document synchronization, undo/redo, recovery (including closing immediately after an uncommitted draft reaches the host), source-mode transitions, URI-backed providers, read-only files, no-op byte preservation, Markdown editing, and split-view synchronization after rename. It passes on the current VS Code and the declared minimum, 1.85.0.

GitHub Actions runs the build and integration suite on macOS, Linux, and Windows against VS Code 1.85.0 and current stable. Linux uses Xvfb; it checks Linux VS Code behavior without claiming native compositor or input-method coverage.

Manual macOS smoke checks cover Explorer opening, Save As, rendered widgets and keyboard navigation, clipboard source fidelity, source-mode selection and scroll preservation, image layout changes, find/replace, dead-key input, accessibility roles, hidden-tab suspension, and the built-in High Contrast theme. Automated integration suites pass on VS Code 1.140.0 and 1.85.0 for macOS and in a Linux x64 Debian container under Xvfb; the Linux run validates the Linux VS Code and extension-host behavior, not a physical Linux desktop compositor. Local 100-sample animation-frame, Chromium compositor-screencast, extension-host edit-preparation, and acknowledgement observations inform the implementation limits; callback and screencast timing do not measure physical display latency. One real SSH-backed workspace round trip has been verified between VS Code 1.85 on macOS and Debian 12 x64; WSL and other remote configurations remain open. Windows, screen-reader interaction, OS forced-colors mode, and real IME composition still need release validation.
