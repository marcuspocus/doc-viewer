# Troubleshooting

Use this page when Doc Viewer is installed but the docs panel does not show what you expect.

## Quick checks

| Check | Expected result |
| --- | --- |
| Plugin id | `doc-viewer` is registered by pi-web. |
| Module | `pi-web-plugin.js` is present in the package. |
| Workspace folder | The active workspace has a `docs/` directory. |
| File types | Docs files end in `.md`, `.mdx`, or `.markdown`. |
| Landing page | Public docs directories include an `index.md` where useful. |
| Package contents | `npm pack --dry-run` includes public docs and excludes ignored working material. |

## The Docs panel is empty

Possible causes:

- The active workspace does not have a `docs/` directory.
- The `docs/` directory has no supported Markdown files.
- Files use unsupported extensions such as `.txt` or `.rst`.
- The workspace tree has not refreshed yet.

Try this:

1. Add a simple `docs/index.md` file.
2. Click the toolbar refresh button.
3. Confirm the file extension is `.md`, `.mdx`, or `.markdown`.
4. Reopen the workspace panel.

Minimal test file:

```markdown
# Project Docs

Hello from Doc Viewer.
```

## A folder looks missing

Nested folders start collapsed. Click the folder row to expand it.

If the folder still does not appear, confirm it contains at least one supported Markdown file somewhere beneath it. Folders with no supported docs files are not useful to the reader and may not appear in the rendered docs tree.

## A file title looks wrong

Doc Viewer uses the first H1 heading as the display title.

If a file appears with a path-like label:

1. Open the file.
2. Add a clear H1 at the top.
3. Refresh the docs tree.

Example:

```markdown
# API Reference

Content starts here.
```

## Search does not find a term

Search runs over discovered docs files after they are loaded.

Try this:

1. Type at least two characters.
2. Wait for the 300ms debounce.
3. Click refresh if files were recently added or edited outside Doc Viewer.
4. Check that the target file is inside `docs/` and uses a supported extension.
5. Search for an exact substring from the Markdown source.

Search is simple full-text matching. It does not currently support fuzzy matching, stemming, or regular expressions.

## Mermaid diagrams do not render

Check the fenced code block language:

````markdown
```mermaid
flowchart LR
  A --> B
```
````

Common fixes:

- Use `mermaid` exactly as the fence language.
- Validate the diagram syntax.
- Keep diagrams small while debugging.
- Refresh and reopen the document.
- Check browser developer tools for a Mermaid error message.

If a diagram fails, the rest of the page should still render.

## Code blocks lose formatting

Fenced code blocks are rendered in scrollable widgets and preserve newlines. Use triple backticks and include a language label when helpful.

````markdown
```js
console.log("newlines stay intact");
```
````

If formatting still looks wrong, check whether the code block fence is closed and whether indentation in the Markdown source is intentional.

## Copy path does nothing

The copy path button is enabled only when a file is selected.

If a file is selected and copying still does not work:

- Make sure the browser allows clipboard access for the pi-web page.
- Try again from a direct user click, not through keyboard automation.
- Confirm the active workspace context has a path available.

## Edit is disabled

Edit mode requires a selected file and loaded Markdown content.

Try this:

1. Select a Markdown file from the tree.
2. Wait for it to render.
3. Click Edit again.
4. Refresh if the file was recently added.

## Cancel did not save my changes

That is expected. Cancel discards the current draft and returns to rendered view mode. Use Save when you want the Markdown file to be written.

## Save fails

Saves are performed through pi-web's stable `context.files.writeFile()` API. A failure usually means the file could not be written in the active workspace.

Check:

- The workspace permits writing to the selected `docs/` file.
- The file still exists at the selected path.
- The pi-web build exposes `context.files.writeFile` (older builds do not, and save will fail).

If save fails, Doc Viewer keeps you in edit mode and shows a toast with the failure message.

## Inline delete does nothing

The trash icon only appears on Markdown files located **directly inside `docs/tmp/`**. Files elsewhere in `docs/` do not expose delete, by design, to protect permanent documentation.

If delete fails:

- Confirm the file is directly under `docs/tmp/` (not a nested subfolder).
- Make sure the pi-web build exposes `context.files.deleteFile`.
- Check that the workspace permits deleting the file.

Delete asks for confirmation first; cancelling keeps the file.

## Copy content does nothing

The copy content button is enabled only when a file is selected. It copies the file's raw Markdown to the clipboard.

If it does not work:

- Select a file first.
- Make sure the browser allows clipboard access for the pi-web page.
- Try again from a direct user click.

## Focus mode is not fullscreen

Focus mode is a CSS overlay layout inside the browser page. It intentionally does not use the browser Fullscreen API.

Expected focus mode behavior:

- toolbar fixed at the top;
- tree on the left;
- viewer or editor on the right;
- the divider between tree and content is **draggable** and the width is remembered across sessions;
- no browser fullscreen permission prompt;
- `Esc` does not exit focus mode.

Click the focus button again to return to normal mode. In normal mode the divider is hidden and the layout is not resizable.

To reset a remembered sidebar width, clear the `doc-viewer:sidebar-width` key from `localStorage`.

## Development smoke tests

Run this syntax/import smoke test from the package root:

```sh
node --eval "import('./pi-web-plugin.js').then(() => console.log('unexpected browser globals ok')).catch(e => { if (String(e.message).includes('window is not defined')) console.log('Parsed OK'); else { console.error(e); process.exit(1); } })"
```

Check the public package file list:

```sh
npm pack --dry-run
```

The dry run should include the plugin module, README, public `docs/*.md`, and pi-web task metadata only.

## Still stuck?

Collect these details before opening an issue:

- pi-web version;
- package version;
- browser name/version;
- whether the workspace is local or remote;
- a minimal `docs/index.md` that reproduces the problem;
- any console error from the browser developer tools.
