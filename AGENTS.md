# Agent Guide — @yieldcraft/doc-viewer

## Project Overview

This is a **pi-web plugin only**. It adds a Docs panel to pi-web that browses and renders markdown files from the workspace `docs/` directory with Mermaid diagram support.

The plugin is **remote-safe**:
- no browser `localhost` server
- no fixed port
- no absolute local paths
- files are read through pi-web's documented `files.readFile()` helper

---

## ⚠️ Documentation Rules (MANDATORY)

These rules apply to **all agents** working on this project, including subagents.

### 1. All documentation goes in `docs/`

Every doc file must be created under `docs/`. No exceptions.

```
docs/
├── index.md              ← REQUIRED: table of contents for docs/
├── README.md
├── architecture.md
├── ...
└── tmp/
    ├── index.md           ← REQUIRED: table of contents for tmp/
    ├── handoff/           ← agent handoff artifacts
    │   └── index.md       ← REQUIRED if handoff/ has other files
    └── ...
```

### 2. Every directory MUST have an `index.md`

- When creating a directory under `docs/`, **always** create an `index.md` in it.
- If a directory exists without an `index.md`, **create one immediately**.
- `index.md` is a table of contents: it lists every `.md` file in that directory with a brief description and a link.
- `index.md` must be **maintained**: when files are added or removed, update the index.

### 3. `docs/tmp/` for ephemeral artifacts

- Temporary files (agent handoffs, scratch output, generated artifacts) go in `docs/tmp/`.
- The `docs/tmp/` directory and its contents are **not** part of the plugin's published documentation.
- They may be deleted or regenerated at any time.
- Every subdirectory under `docs/tmp/` must also have its own `index.md`.

### 4. `index.md` template

```markdown
# 📖 Directory Name Index

> Auto-maintained index. Every document in this directory is listed below.

| Document | Description |
|---|---|
| [document-name](document-name.md) | Brief description |
```

---

## Critical Rules

1. **Never insert absolute local paths** — all file reads go through `context.files.readFile()`
2. **Never modify PI WEB itself** — this is a plugin-only project
3. **Never commit/push/publish without explicit user confirmation**
4. **Never create docs outside `docs/`** — all documentation, handoffs, and scratch go under `docs/`
5. **Every directory must have an `index.md`** — create it if missing, maintain it when files change
6. **JAMAIS de commit ni push git sans approbation explicite de l'utilisateur** — même si les builds/tests passent, même si ça semble logique, toujours demander d'abord

---

## Remote-Safe File Reading Flow

```
User opens Docs panel
  → plugin fetches docs/ tree via pi-web workspace file tree API
  → plugin renders file list in sidebar
  → user clicks a file
  → plugin reads file content via context.files.readFile(path)
  → plugin renders markdown → HTML
  → mermaid code blocks → mermaid.js render → SVG
  → content displayed in panel via direct DOM innerHTML
```

---

## Rendering Rules (HARD CONSTRAINTS)

These rules come from a critical bug that froze Chrome.

1. **`render()` must return a SYNCHRONOUS lit `TemplateResult`** — no async work, no `requestRender()` inside `render()`.
2. **All dynamic content goes via direct DOM** — use `querySelectorAllDeep()`, `innerHTML`, `document.createElement()`, `onclick` — never lit template reactivity for data-driven content.
3. **Never call `requestRender()` from inside `render()`** — this creates an infinite loop that freezes Chrome. Only call `requestRender()` from outside (e.g., after an async fetch completes).
4. **Use pi-web CSS variables** for chrome elements: `--pi-border`, `--pi-surface`, `--pi-text`, `--pi-accent`, `--pi-muted`, `--pi-code-bg`.
5. **Must work inside shadow DOM** — use `querySelectorAllDeep()` to find elements.

---

## Architecture Details

### Browser Plugin (`pi-web-plugin.js`)

Key functions:

- `fetchDocsTree(context)` — lists `docs/` via pi-web workspace file tree API
- `flattenTree(entries, prefix)` — recursively flattens the tree, filtering `.md` files
- `readFileContent(path, context)` — reads a single file via `context.files.readFile()`
- `renderMarkdown(text)` — converts markdown to HTML (headings, lists, tables, blockquotes, code, inline)
- `renderCodeBlock(lang, code)` — renders code blocks; mermaid blocks get a special container
- `renderTableOfContents(headings)` — auto-generates a TOC from heading IDs
- `ensureMermaid()` — lazy-loads mermaid.js from CDN on first use
- `renderMermaidDiagrams()` — renders all mermaid blocks in the DOM
- `renderPanelDOM(context)` — injects all dynamic content via direct DOM manipulation
- `loadAndRenderFile(path, context)` — reads, renders, caches a file, updates content div

State:

- `currentFile` — path of the currently viewed file (or null)
- `fileTree` — array of {path, name, modifiedAt} for all `docs/*.md` files
- `fileTreeKey` — cache key to detect workspace changes
- `renderedFiles` — Map of path → rendered HTML (cache)
- `fileContents` — Map of path → raw markdown text (cache)
- `panelContext` — last render context for DOM callbacks

---

## File Structure

```txt
doc-viewer/
├── pi-web-plugin.js              # Browser plugin loaded by pi-web
├── package.json                  # npm package + piWeb.plugins metadata
├── .pi-web/tasks.json            # Public-safe workspace tasks
├── docs/                         # All documentation
│   ├── index.md                  # Documentation index (REQUIRED)
│   ├── README.md                 # Quick start
│   ├── architecture.md           # Architecture & data flow
│   ├── approach.md               # Lessons learned
│   ├── mermaid.md                # Mermaid diagram support
│   ├── api-reference.md          # Plugin API reference
│   ├── troubleshooting.md        # Common issues
│   └── tmp/                      # Ephemeral artifacts (handoffs, scratch)
│       └── index.md              # tmp index (REQUIRED)
├── README.md
└── AGENTS.md
```

---

## Pi-web Plugin API Usage

This plugin uses:

- `apiVersion: 1`
- `activate({ html, svg })` — receives lit template functions
- `contributions.actions` — "Open Documentation Viewer" action (⌘⇧D)
- `contributions.workspacePanels` — "Docs" panel with file list and rendered content
- `context.files.readFile(path)` — stable API to read workspace files
- `context.host.requestRender()` — triggers panel re-render (ONLY from outside render!)
- `context.terminal.runCommand()` — runs commands on selected machine (edit mode save)
- `context.machine`, `context.workspace` — stable context for workspace identification

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| Panel shows "No docs/ folder found" | No `docs/` directory in workspace | Create `docs/` with `.md` files |
| Mermaid diagrams show "⏳ Rendering…" forever | CDN blocked or mermaid.js failed | Check network, mermaid v11 CDN availability |
| Mermaid diagram error | Invalid mermaid syntax | Fix diagram syntax, check mermaid docs |
| File list empty but docs/ exists | Wrong workspace selected | Check active workspace in pi-web |
| Content not updating after file change | Render cache is stale | Switch file and back, or reload pi-web |
| Code copy button doesn't work | Clipboard API blocked | Check browser permissions for clipboard |
| Chrome freezes / tab must be killed | `requestRender()` called from `render()` | Ensure render() is always synchronous |

---

## License

MIT © YieldCraft