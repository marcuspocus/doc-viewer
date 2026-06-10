# Documentation Guide

This directory contains the public documentation for `@yieldcraft/doc-viewer`.

Doc Viewer itself reads from a workspace `docs/` directory, so this documentation also serves as a realistic example of the structure the plugin is designed to display.

## Pages

| File | Purpose |
| --- | --- |
| [`index.md`](index.md) | Public documentation home and reader entry point. |
| [`architecture.md`](architecture.md) | System structure, data flow, and rendering lifecycle. |
| [`approach.md`](approach.md) | Implementation principles, development workflow, and public release model. |
| [`mermaid.md`](mermaid.md) | Mermaid authoring guidance and examples. |
| [`api-reference.md`](api-reference.md) | Plugin metadata, pi-web integration points, and behavior reference. |
| [`troubleshooting.md`](troubleshooting.md) | Common problems and practical fixes. |

## Reader paths

| Reader | Start here | Then read |
| --- | --- | --- |
| New user | [`index.md`](index.md) | [`troubleshooting.md`](troubleshooting.md) if something does not appear as expected. |
| Plugin integrator | [`api-reference.md`](api-reference.md) | [`architecture.md`](architecture.md). |
| Maintainer | [`approach.md`](approach.md) | [`architecture.md`](architecture.md) and [`api-reference.md`](api-reference.md). |
| Documentation author | [`mermaid.md`](mermaid.md) | [`index.md`](index.md) for layout conventions. |

## Public documentation standards

Keep public docs:

- English-only.
- Accurate to the current implementation.
- Safe for npm and public source hosting.
- Focused on user-facing behavior, not temporary working notes.
- Clear about the distinction between **normal mode** and **focus mode**.
- Free of local machine paths, tokens, non-public hostnames, and ignored artifacts.

## Directory index requirement

Every public documentation directory should include an `index.md` file. Doc Viewer sorts `index.md` first, which makes each folder easier to scan and gives readers a predictable landing page.

For example:

```text
docs/
├── index.md
└── guides/
    ├── index.md
    └── usage.md
```

## Writing tips for Doc Viewer

- Start each page with a single H1. The tree uses the first H1 as the display title.
- Prefer short sections with descriptive H2 headings.
- Use fenced code blocks for commands and examples.
- Use Mermaid diagrams for flows, states, and architecture that would otherwise require long prose.
- Keep tables compact; they work best for feature matrices and troubleshooting checklists.
