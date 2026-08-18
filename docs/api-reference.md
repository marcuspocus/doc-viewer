# API Reference

This page summarizes Doc Viewer's public package metadata, pi-web contributions, and runtime behavior.

## Package metadata

| Field | Value |
| --- | --- |
| Package name | `@yieldcraft/doc-viewer` |
| Package type | ES module (`"type": "module"`) |
| Plugin module | `pi-web-plugin.js` |
| License | MIT |
| Public docs path | `docs/*.md` |

## pi-web plugin registration

`package.json` declares the pi-web plugin entry:

```json
{
  "piWeb": {
    "plugins": [
      {
        "id": "doc-viewer",
        "browserRoot": ".",
        "module": "pi-web-plugin.js"
      }
    ]
  }
}
```

## Plugin object

The module exports the plugin object as the default export.

| Property | Value |
| --- | --- |
| `apiVersion` | `1` |
| `name` | `Doc Viewer` |
| `activate` | Registers styles, actions, and workspace panel contributions. |
| `deactivate` | Cancels pending renders, unwires toolbar and resizer listeners, stops the Mermaid poller, removes injected DOM (toast container, Mermaid script, global copy handler), and clears browser-side caches/state. |

## Action contribution

| Field | Value |
| --- | --- |
| Action id | `open-docs` |
| Title | `Open Documentation Viewer` |
| Group | `Docs` |
| Shortcut | `mod+shift+d` |
| Enabled when | A workspace is selected. |
| Behavior | Selects the Doc Viewer workspace tool/panel when pi-web exposes the workspace tool selector. |

## Workspace panel contribution

| Field | Value |
| --- | --- |
| Panel id | `docs` |
| Title | `Docs` |
| Order | `8500` |
| Badge | Number of discovered Markdown files when the tree has loaded. |
| Shell | Synchronous `toolbar` and `viewer` sections. |

The panel shell contains:

```html
<section class="toolbar">...</section>
<section class="viewer doc-viewer-panel">...</section>
```

## Supported source files

Doc Viewer reads Markdown documentation from the workspace `docs/` directory.

| Extension | Included |
| --- | --- |
| `.md` | Yes |
| `.mdx` | Yes |
| `.markdown` | Yes |
| Other extensions | No |

## File-tree behavior

| Behavior | Reference |
| --- | --- |
| Root | `docs/` is the only documentation root. |
| Recursion | Nested folders are scanned recursively. |
| Collapsed folders | Nested folders start collapsed. |
| Root row | The `docs/` root is shown and can be collapsed or expanded. |
| Folder rows | Clickable; toggle collapse/expand. |
| File labels | First H1 heading, then fallback file label. |
| Sort order | `index.md` first, then alphabetical within folders. |
| Icons | Folder, document, and index icons. |

## Toolbar actions

| Action | Behavior |
| --- | --- |
| Search | Debounced full-text search across discovered docs. |
| Refresh | Clears tree/content caches and reloads `docs/`. |
| Copy path | Copies the selected file's full workspace path to the clipboard. |
| Copy content | Copies the selected Markdown file's raw content to the clipboard. |
| Edit | Opens the selected Markdown file in edit mode. |
| Save | Writes the edit draft through pi-web's stable `context.files.writeFile()` API. |
| Cancel | Discards the edit draft and returns to view mode. |
| Focus | Toggles CSS-based focus mode. |
| Delete (inline) | Shown only on files directly inside `docs/tmp/`; deletes the file via `context.files.deleteFile()` after confirmation. |

## Modes

| Mode | Internal role | User-facing meaning |
| --- | --- | --- |
| `view` | Render selected Markdown. | Normal reading state. |
| `search` | Show search results. | Searching documentation. |
| `edit` | Show textarea editor. | Editing selected Markdown. |
| `normal` | Standard layout. | Normal mode. |
| `focus` | CSS overlay layout. | Focus mode. |

`view`, `search`, and `edit` describe content state. `normal` and `focus` describe layout state.

## Markdown rendering support

| Feature | Support |
| --- | --- |
| H1-H6 headings | Yes, with slug ids. |
| Table of contents | Generated from rendered headings. |
| Paragraphs | Yes. |
| Bold and italic | Yes. |
| Strikethrough | Yes. |
| Links | Yes, opened with `target="_blank"` and `rel="noopener"`. |
| Images | Yes, responsive width. |
| Ordered and unordered lists | Yes. |
| Blockquotes | Yes. |
| Horizontal rules | Yes. |
| Tables | Yes. |
| Inline code | Yes. |
| Fenced code blocks | Yes, with language label and copy button. |
| Mermaid fenced blocks | Yes, rendered as diagrams. |

## pi-web runtime APIs used

Doc Viewer depends on the pi-web plugin context for workspace information and file operations.

| Runtime capability | Use |
| --- | --- |
| `context.machine.id` | Builds workspace-specific tree keys and tree URLs. |
| `context.workspace.id` | Builds workspace-specific tree keys and tree URLs. |
| `context.workspace.projectId` | Builds tree URLs. |
| `context.workspace.path` | Builds the full path copied by the toolbar. |
| `context.files.readFile(path)` | Reads Markdown files for titles, rendering, search, and edit mode. |
| `context.files.writeFile(path, content)` | Saves edited Markdown directly in the active workspace. |
| `context.files.deleteFile(path)` | Deletes a `docs/tmp/` Markdown file from the inline delete action. |
| `context.piWebUnstable.selectWorkspaceTool(...)` | Opens/selects the Doc Viewer panel from the action contribution when available. |

## Browser/runtime APIs used

| API | Use |
| --- | --- |
| `fetch` | Loads the `docs/` workspace tree. |
| `navigator.clipboard.writeText` | Copies the selected full file path and the selected file's raw content. |
| `requestAnimationFrame` / `setTimeout` | Run DOM updates after the panel shell mounts, tracked and cancelled via `scheduleRender`/`cancelPendingRenders`. |
| `localStorage` | Persists the focus-mode sidebar width (`doc-viewer:sidebar-width`). |
| `window.mermaid` | Renders Mermaid diagrams after the Mermaid library is loaded. |

## Focus mode reference

Focus mode is implemented with CSS classes applied to existing pi-web panel sections.

| Detail | Behavior |
| --- | --- |
| Browser Fullscreen API | Not used. |
| `requestFullscreen` | Not called. |
| Escape key | Does not exit focus mode. |
| Layout | Fixed toolbar top, docs tree left, viewer/editor right. |
| Resizable divider | Drag the divider between the tree and content to resize; width persists in `localStorage`. |
| Sidebar width limits | Min 180px, max 60% of panel width. |
| Default split | ~25% navigation / ~75% content, until the user drags the divider. |

## Package allowlist

`package.json` publishes only these paths:

```json
[
  "pi-web-plugin.js",
  "README.md",
  "docs/*.md",
  ".pi-web/tasks.json"
]
```

This keeps temporary and ignored working files out of the npm package.
