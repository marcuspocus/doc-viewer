// doc-viewer — Pi-web plugin to browse and render workspace docs/ markdown files
// with Mermaid diagram rendering support, toolbar, search, and edit mode.

const DOCS_DIR = "docs";
const MD_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
const MERMAID_VERSION = "11";
const PLUGIN_VERSION = "0.2.0";

// ── State ─────────────────────────────────────────────────────────────────
let mermaidReady = false;
let mermaidLoading = false;
let currentFile = null;
let fileTree = null;
let fileTreeKey = null;
let fileTitles = new Map();      // path → extracted h1 title
let panelContext = null;
let searchDebounceTimer = null;
let mode = "view";               // "view" | "search" | "edit"
let editBackup = null;
let editDraft = null;
let treeFetchPromise = null;
let collapsedDirsKey = null;
let viewMode = "normal"; // "normal" | "focus"
const MAX_CACHE_SIZE = 50;
const renderedFiles = new Map();
const fileContents = new Map();
const collapsedDirs = new Set();

// ── Scheduled render tracking (cancel on new render / deactivate) ─────────
let pendingRafIds = [];
let pendingTimeoutIds = [];

function cancelPendingRenders() {
  for (const id of pendingRafIds) cancelAnimationFrame(id);
  for (const id of pendingTimeoutIds) clearTimeout(id);
  pendingRafIds = [];
  pendingTimeoutIds = [];
}

function scheduleRender(fn) {
  let rafId, timeoutId;
  let executed = false;
  const run = () => {
    if (executed) return;
    executed = true;
    clearTimeout(timeoutId);
    const tIdx = pendingTimeoutIds.indexOf(timeoutId);
    if (tIdx !== -1) pendingTimeoutIds.splice(tIdx, 1);
    const rIdx = pendingRafIds.indexOf(rafId);
    if (rIdx !== -1) pendingRafIds.splice(rIdx, 1);
    fn();
  };
  rafId = requestAnimationFrame(run);
  pendingRafIds.push(rafId);
  timeoutId = setTimeout(() => {
    const rIdx = pendingRafIds.indexOf(rafId);
    if (rIdx !== -1) pendingRafIds.splice(rIdx, 1);
    const tIdx = pendingTimeoutIds.indexOf(timeoutId);
    if (tIdx !== -1) pendingTimeoutIds.splice(tIdx, 1);
    requestAnimationFrame(run);
  }, 120);
  pendingTimeoutIds.push(timeoutId);
}

// ── LRU cache eviction ────────────────────────────────────────────────────
function evictIfNeeded(map, max) {
  if (map.size <= max) return;
  const keys = [...map.keys()];
  const evictCount = keys.length - max;
  for (let i = 0; i < evictCount; i++) map.delete(keys[i]);
}

// ── File tree helpers ─────────────────────────────────────────────────────
function treeKey(context) {
  return `${context.machine.id}:${context.workspace.id}`;
}

async function fetchDocsTree(context) {
  const key = treeKey(context);
  if (fileTreeKey === key && fileTree) return fileTree;

  try {
    const entries = await fetchTreeEntries(context, DOCS_DIR);
    const flattened = await flattenTree(entries, DOCS_DIR, context);
    fileTree = [...new Map(flattened.map(f => [f.path, f])).values()];
    fileTreeKey = key;
    if (collapsedDirsKey !== key) {
      collapsedDirs.clear();
      for (const dir of collectDirectories(fileTree)) {
        if (dir !== DOCS_DIR) collapsedDirs.add(dir);
      }
      collapsedDirsKey = key;
    }
    // Lazy title extraction: only fetch titles for files already in cache
    for (const f of fileTree) {
      const cached = fileContents.get(f.path);
      if (cached && !fileTitles.has(f.path)) {
        fileTitles.set(f.path, extractTitle(cached));
      }
    }
    return fileTree;
  } catch (err) {
    console.warn("[doc-viewer] Could not fetch docs tree:", err);
    fileTree = [];
    fileTreeKey = key;
    return [];
  }
}

async function fetchTreeEntries(context, path) {
  const data = await context.files.listFiles(path);
  return Array.isArray(data?.entries) ? data.entries : [];
}

async function flattenTree(entries, prefix, context) {
  const result = [];
  for (const entry of entries) {
    const rawPath = entry.path ?? `${prefix}/${entry.name}`;
    const entryPath = rawPath === prefix || rawPath.startsWith(`${prefix}/`) || rawPath.startsWith(`${DOCS_DIR}/`)
      ? rawPath
      : `${prefix}/${entry.name ?? rawPath.split("/").pop()}`;
    const entryType = String(entry.type ?? "").toLowerCase();
    if (entryType === "file" && isMarkdownFile(entryPath)) {
      result.push({ path: entryPath, name: entry.name, modifiedAt: entry.modifiedAt });
    }
    if (entryType === "directory" || entryType === "dir") {
      const childEntries = Array.isArray(entry.entries)
        ? entry.entries
        : await fetchTreeEntries(context, entryPath);
      result.push(...await flattenTree(childEntries, entryPath, context));
    }
  }
  return result.sort((a, b) => {
    const aDir = dirname(a.path);
    const bDir = dirname(b.path);
    if (aDir !== bDir) {
      if (aDir === "docs") return -1;
      if (bDir === "docs") return 1;
      return aDir.localeCompare(bDir);
    }
    // index.md always first inside its directory, then alphabetical/title order.
    const aIsIndex = a.name.toLowerCase() === "index.md";
    const bIsIndex = b.name.toLowerCase() === "index.md";
    if (aIsIndex && !bIsIndex) return -1;
    if (!aIsIndex && bIsIndex) return 1;
    return a.path.localeCompare(b.path);
  });
}

function isMarkdownFile(path) {
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return MD_EXTENSIONS.has(path.substring(dotIdx).toLowerCase());
}

// ── Title extraction ──────────────────────────────────────────────────────
// Titles are extracted lazily when a file is first read (see readFileContent).
// No bulk pre-fetch — avoids flooding the API with N requests on tree load.

function extractTitle(text) {
  // Try first # heading
  const h1Match = text.match(/^#\s+(.+)/m);
  if (h1Match) return h1Match[1].trim();
  // Try first line as fallback
  const firstLine = text.split("\n").find(l => l.trim());
  if (firstLine) return firstLine.trim().replace(/^#+\s*/, "").slice(0, 60);
  return null;
}

function dirname(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function displayDirName(dir) {
  if (dir === "docs") return "docs/";
  return dir.split("/").pop() + "/";
}

function collectDirectories(files) {
  const dirs = new Set([DOCS_DIR]);
  for (const f of files) {
    const parts = dirname(f.path).split("/");
    for (let i = 0; i < parts.length; i++) {
      dirs.add(parts.slice(0, i + 1).join("/"));
    }
  }
  return [...dirs].filter(Boolean);
}

function buildDirectoryTree(files) {
  const root = { path: DOCS_DIR, name: DOCS_DIR, dirs: new Map(), files: [] };
  for (const f of files) {
    const rel = f.path.replace(/^docs\//, "");
    const parts = rel.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const childPath = `${node.path}/${part}`;
      if (!node.dirs.has(part)) node.dirs.set(part, { path: childPath, name: part, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  return root;
}

function displayName(f) {
  if (f.name?.toLowerCase() === "index.md") return "Index";
  const title = fileTitles.get(f.path);
  if (title) return title;
  return f.path.replace(/^docs\//, "");
}

function fullWorkspacePath(context, relativePath) {
  const base = String(context?.workspace?.path ?? "").replace(/\/+$/, "");
  const rel = String(relativePath ?? "").replace(/^\/+/, "");
  return base ? `${base}/${rel}` : rel;
}

function resolveDocLink(href, fromPath = currentFile) {
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const [rawPath] = href.split("#");
  if (!rawPath || !isMarkdownFile(rawPath)) return null;
  const baseDir = fromPath ? dirname(fromPath) : DOCS_DIR;
  const joined = rawPath.startsWith("/") ? rawPath.slice(1) : `${baseDir}/${rawPath}`;
  const parts = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function fileIcon(f) {
  if (f.name.toLowerCase() === "index.md") return "index";
  return "doc";
}

function svgWrap(inner) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function iconSvg(kind) {
  if (kind === "folder") return svgWrap('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/>');
  if (kind === "index") return svgWrap('<path d="M6 3.75h8.25L18 7.5v12.75H6V3.75Z"/><path d="M14 3.75V8h4"/><path d="M8.75 11h6.5M8.75 14h6.5M8.75 17h4"/>');
  if (kind === "refresh") return svgWrap('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v6h-6"/>');
  if (kind === "copy") return svgWrap('<rect x="8" y="8" width="11" height="13" rx="2"/><path d="M5 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
  if (kind === "copy-path") return svgWrap('<path d="M4 7h6"/><path d="M14 7h6"/><circle cx="12" cy="7" r="2"/><path d="M12 9v6"/><circle cx="12" cy="17" r="2"/><path d="M4 17h6"/><path d="M14 17h6"/>');
  if (kind === "copy-content") return svgWrap('<path d="M6 3.75h8.25L18 7.5v12.75H6V3.75Z"/><path d="M14 3.75V8h4"/><path d="M8.75 11h6.5"/><path d="M8.75 14h6.5"/><path d="M8.75 17h4"/>');
  if (kind === "edit") return svgWrap('<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.5 7.5 2 2"/>');
  if (kind === "save") return svgWrap('<path d="M5 3h12l2 2v16H5V3Z"/><path d="M8 3v6h8V3"/><path d="M8 21v-7h8v7"/>');
  if (kind === "cancel") return svgWrap('<path d="m6 6 12 12M18 6 6 18"/>');
  if (kind === "trash") return svgWrap('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>');
  if (kind === "search") return svgWrap('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>');
  if (kind === "expand") return svgWrap('<path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M21 16v5h-5"/><path d="M8 21H3v-5"/><path d="M3 3l7 7"/><path d="M21 3l-7 7"/><path d="M21 21l-7-7"/><path d="M3 21l7-7"/>');
  if (kind === "collapse") return svgWrap('<path d="M10 3v7H3"/><path d="M14 3v7h7"/><path d="M14 21v-7h7"/><path d="M10 21v-7H3"/>');
  if (kind === "chevron-down") return svgWrap('<path d="m6 9 6 6 6-6"/>');
  if (kind === "chevron-right") return svgWrap('<path d="m9 6 6 6-6 6"/>');
  return svgWrap('<path d="M6 3.75h8.25L18 7.5v12.75H6V3.75Z"/><path d="M14 3.75V8h4"/>');
}

// ── File reading ──────────────────────────────────────────────────────────
async function readFileContent(path, context) {
  if (fileContents.has(path)) return fileContents.get(path);
  try {
    const result = await context.files.readFile(path);
    const text = result?.content ?? result?.text ?? (typeof result === "string" ? result : "");
    fileContents.set(path, text);
    evictIfNeeded(fileContents, MAX_CACHE_SIZE);
    // Extract title lazily on first read
    if (!fileTitles.has(path)) {
      fileTitles.set(path, extractTitle(text));
    }
    return text;
  } catch (err) {
    console.warn("[doc-viewer] Could not read file:", path, err);
    return null;
  }
}

// ── Search ─────────────────────────────────────────────────────────────────
function searchDocs(query) {
  const results = [];
  const q = query.toLowerCase();
  for (const [path, content] of fileContents.entries()) {
    if (!content) continue;
    const lowerContent = content.toLowerCase();
    const idx = lowerContent.indexOf(q);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 80);
    const end = Math.min(content.length, idx + query.length + 80);
    const snippet = (start > 0 ? "\u2026" : "") + content.slice(start, end) + (end < content.length ? "\u2026" : "");
    const title = fileTitles.get(path) ?? path.split("/").pop();
    results.push({ path, title, snippet, matchStart: idx - start });
  }
  results.sort((a, b) => {
    const aNameMatch = a.title.toLowerCase().includes(q) ? 0 : 1;
    const bNameMatch = b.title.toLowerCase().includes(q) ? 0 : 1;
    if (aNameMatch !== bNameMatch) return aNameMatch - bNameMatch;
    return a.path.localeCompare(b.path);
  });
  return results;
}

function highlightSnippet(snippet, query) {
  const q = query.toLowerCase();
  const lowerSnippet = snippet.toLowerCase();
  let result = "";
  let lastIdx = 0;
  let idx = lowerSnippet.indexOf(q);
  while (idx !== -1) {
    result += escapeHtml(snippet.slice(lastIdx, idx));
    result += `<mark class="dv-highlight">${escapeHtml(snippet.slice(idx, idx + query.length))}</mark>`;
    lastIdx = idx + query.length;
    idx = lowerSnippet.indexOf(q, lastIdx);
  }
  result += escapeHtml(snippet.slice(lastIdx));
  return result;
}

async function ensureAllFileContents(context) {
  const tree = fileTree ?? [];
  const promises = [];
  for (const f of tree) {
    if (!fileContents.has(f.path)) promises.push(readFileContent(f.path, context));
  }
  if (promises.length > 0) await Promise.all(promises);
}

function wireDocumentLinks(root, context) {
  if (!root) return;
  root.querySelectorAll('a[href]').forEach(link => {
    const targetPath = resolveDocLink(link.getAttribute('href'));
    if (!targetPath) return;
    if (!fileTree?.some(f => f.path === targetPath)) return;
    link.removeAttribute('target');
    link.onclick = (event) => {
      event.preventDefault();
      if (mode === "edit") return;
      currentFile = targetPath;
      mode = "view";
      querySelectorAllDeep(".dv-toolbar-search").forEach(i => { i.value = ""; });
      updateSidebarActive();
      updateToolbarState();
      renderFileContent(context);
    };
  });
}

function renderSearchResults(results, query) {
  const content = activeElement(".doc-viewer-content");
  if (!content) return;
  if (results.length === 0) {
    content.innerHTML = `<div class="dv-search"><p class="dv-muted">No results for "${escapeHtml(query)}". Try different keywords.</p></div>`;
    return;
  }
  let html = `<div class="dv-search"><div class="dv-search-meta">${results.length} result${results.length !== 1 ? "s" : ""} for "${escapeHtml(query)}"</div>`;
  for (const r of results) {
    html += `<article class="dv-search-result"><h3 class="dv-search-result-title"><a data-path="${escapeHtml(r.path)}">${escapeHtml(fileIcon({ name: r.path.split("/").pop(), path: r.path }))} ${escapeHtml(r.title)}</a></h3><p class="dv-search-result-snippet">${highlightSnippet(r.snippet, query)}</p><span class="dv-search-result-path">${escapeHtml(r.path)}</span></article>`;
  }
  html += "</div>";
  content.innerHTML = html;
  content.querySelectorAll(".dv-search-result-title a").forEach(a => {
    a.onclick = () => {
      const path = a.dataset.path;
      const inputs = querySelectorAllDeep(".dv-toolbar-search");
      inputs.forEach(i => { i.value = ""; });
      mode = "view";
      currentFile = path;
      updateSidebarActive();
      updateToolbarState();
      renderFileContent(getPanelContext());
    };
  });
}

// ── Markdown rendering ────────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '<p class="dv-muted">Empty file.</p>';

  const codeBlockMap = new Map();
  let codeIdx = 0;
  let protected_text = text;

  protected_text = protected_text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `%%CODEBLOCK_${codeIdx}%%`;
    codeBlockMap.set(placeholder, { lang: lang.toLowerCase(), code: code.replace(/\n$/, "") });
    codeIdx++;
    return placeholder;
  });

  protected_text = protected_text.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `%%INLINECODE_${codeIdx}%%`;
    codeBlockMap.set(placeholder, { lang: "inline", code });
    codeIdx++;
    return placeholder;
  });

  let html = "";
  let inList = false;
  let listType = null;
  const lines = protected_text.split("\n");

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];

    if (/^%%CODEBLOCK_\d+%%$/.test(line.trim())) {
      if (inList) { html += listType === "ul" ? "</ul>" : "</ol>"; inList = false; }
      const block = codeBlockMap.get(line.trim());
      if (block) html += renderCodeBlock(block.lang, block.code);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      if (inList) { html += listType === "ul" ? "</ul>" : "</ol>"; inList = false; }
      const level = headingMatch[1].length;
      const headingText = formatInlineMarkdown(headingMatch[2], codeBlockMap);
      const id = slugify(headingMatch[2]);
      html += `<h${level} id="${id}">${headingText}</h${level}>`;
      continue;
    }

    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      if (inList) { html += listType === "ul" ? "</ul>" : "</ol>"; inList = false; }
      html += "<hr>";
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      if (inList) { html += listType === "ul" ? "</ul>" : "</ol>"; inList = false; }
      html += `<blockquote><p>${formatInlineMarkdown(line.replace(/^\s*>\s?/, ""), codeBlockMap)}</p></blockquote>`;
      continue;
    }

    const ulMatch = line.match(/^[\s]*[-*+]\s+(.+)/);
    if (ulMatch) {
      if (!inList || listType !== "ul") {
        if (inList) html += listType === "ul" ? "</ul>" : "</ol>";
        html += "<ul>"; inList = true; listType = "ul";
      }
      html += `<li>${formatInlineMarkdown(ulMatch[1], codeBlockMap)}</li>`;
      continue;
    }

    const olMatch = line.match(/^[\s]*\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList || listType !== "ol") {
        if (inList) html += listType === "ul" ? "</ul>" : "</ol>";
        html += "<ol>"; inList = true; listType = "ol";
      }
      html += `<li>${formatInlineMarkdown(olMatch[1], codeBlockMap)}</li>`;
      continue;
    }

    if (inList && line.trim() === "") {
      html += listType === "ul" ? "</ul>" : "</ol>"; inList = false;
      continue;
    }

    if (line.includes("|") && li + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[li + 1] ?? "")) {
      if (inList) { html += listType === "ul" ? "</ul>" : "</ol>"; inList = false; }
      const tableResult = renderTable(lines, li, codeBlockMap);
      if (tableResult) { html += tableResult.html; li = tableResult.endIndex; continue; }
    }

    if (line.trim() === "") {
      if (inList) { html += listType === "ul" ? "</ul>" : "</ol>"; inList = false; }
      continue;
    }

    if (inList) { html += listType === "ul" ? "</ul>" : "</ol>"; inList = false; }
    html += `<p>${formatInlineMarkdown(line, codeBlockMap)}</p>`;
  }

  if (inList) html += listType === "ul" ? "</ul>" : "</ol>";

  for (const [placeholder, block] of codeBlockMap) {
    if (block.lang === "inline") {
      html = html.replace(placeholder, `<code>${escapeHtml(block.code)}</code>`);
    }
  }

  return html;
}

function formatInlineMarkdown(text, codeBlockMap) {
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:6px;">');
  for (const [placeholder, block] of codeBlockMap) {
    if (block.lang === "inline") {
      text = text.replace(placeholder, `<code>${escapeHtml(block.code)}</code>`);
    }
  }
  return text;
}

function renderCodeBlock(lang, code) {
  const escapedCode = escapeHtml(code);
  if (lang === "mermaid") {
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return `<div class="doc-viewer-mermaid" data-mermaid-id="${id}">`
      + `<pre class="mermaid-source" style="display:none;">${escapedCode}</pre>`
      + `<div class="mermaid-render" id="${id}"><div class="mermaid-loading">⏳ Rendering diagram…</div></div>`
      + `</div>`;
  }
  const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '<span class="code-lang">text</span>';
  const copyBtn = `<button class="code-copy-btn" onclick="docViewerCopyCode(this)" title="Copy to clipboard">📋</button>`;
  return `<div class="doc-viewer-code-block"><div class="code-header">${langLabel}${copyBtn}</div><pre><code class="language-${lang || "text"}">${escapedCode}</code></pre></div>`;
}

function renderTable(lines, startIndex, codeBlockMap = new Map()) {
  const rows = [];
  let i = startIndex;
  while (i < lines.length && lines[i].includes("|")) {
    const cells = lines[i].split("|").map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length);
    rows.push(cells);
    i++;
  }
  if (rows.length < 2) return null;
  let html = '<table class="doc-viewer-table">';
  for (let r = 0; r < rows.length; r++) {
    if (r === 1 && rows[r].every(c => /^[:\-\s]+$/.test(c))) continue;
    const tag = r === 0 ? "th" : "td";
    html += "<tr>" + rows[r].map(c => `<${tag}>${formatInlineMarkdown(c, codeBlockMap)}</${tag}>`).join("") + "</tr>";
  }
  html += "</table>";
  return { html, endIndex: i - 1 };
}

function slugify(text) {
  return text.toLowerCase().replace(/[^\w]+/g, "-").replace(/(^-|-$)/g, "");
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ── Mermaid ────────────────────────────────────────────────────────────────
async function ensureMermaid() {
  if (mermaidReady) return true;
  if (mermaidLoading) {
    return new Promise((resolve) => {
      let resolved = false;
      mermaidPollerIntervalId = setInterval(() => {
        if (mermaidReady) {
          clearInterval(mermaidPollerIntervalId); mermaidPollerIntervalId = null;
          if (mermaidPollerTimeoutId) { clearTimeout(mermaidPollerTimeoutId); mermaidPollerTimeoutId = null; }
          resolved = true; resolve(true);
        }
      }, 100);
      mermaidPollerTimeoutId = setTimeout(() => {
        clearInterval(mermaidPollerIntervalId); mermaidPollerIntervalId = null;
        mermaidPollerTimeoutId = null;
        if (!resolved) resolve(false);
      }, 30000);
    });
  }
  if (window.mermaid) { mermaidReady = true; return true; }
  mermaidLoading = true;
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
    script.onload = () => {
      try { window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose", fontFamily: "inherit" }); } catch {}
      mermaidReady = true; mermaidLoading = false; resolve(true);
    };
    script.onerror = () => { console.warn("[doc-viewer] Failed to load mermaid"); mermaidLoading = false; resolve(false); };
    document.head.appendChild(script);
  });
}

async function renderMermaidDiagrams(root) {
  const scope = root?.isConnected ? root : activeElement(".doc-viewer-content");
  if (!scope) return;
  const containers = [...scope.querySelectorAll(".doc-viewer-mermaid")];
  if (containers.length === 0) return;
  const loaded = await ensureMermaid();
  if (!loaded) {
    containers.forEach(c => {
      const r = c.querySelector(".mermaid-render");
      if (r) r.innerHTML = '<p class="muted">Mermaid CDN failed to load.</p>';
      const s = c.querySelector(".mermaid-source");
      if (s) s.style.display = "block";
    });
    return;
  }
  for (const container of containers) {
    const sourceEl = container.querySelector(".mermaid-source");
    const renderEl = container.querySelector(".mermaid-render");
    if (!sourceEl || !renderEl || renderEl.dataset.rendered === "true") continue;
    const source = sourceEl.textContent;
    try {
      const { svg } = await window.mermaid.render(renderEl.id, source);
      renderEl.innerHTML = svg;
      renderEl.dataset.rendered = "true";
    } catch (err) {
      console.warn("[doc-viewer] Mermaid render error:", err);
      renderEl.innerHTML = `<p class="muted" style="color:var(--pi-error,#f85149);">⚠️ Diagram error: ${escapeHtml(err?.message ?? String(err))}</p>`;
      sourceEl.style.display = "block";
    }
  }
}

// ── Mermaid polling cleanup ────────────────────────────────────────────────
let mermaidPollerIntervalId = null;
let mermaidPollerTimeoutId = null;

function cancelMermaidPoller() {
  if (mermaidPollerIntervalId) { clearInterval(mermaidPollerIntervalId); mermaidPollerIntervalId = null; }
  if (mermaidPollerTimeoutId) { clearTimeout(mermaidPollerTimeoutId); mermaidPollerTimeoutId = null; }
}
if (!window.docViewerCopyCode) {
  window.docViewerCopyCode = function (btn) {
    const block = btn.closest(".doc-viewer-code-block");
    if (!block) return;
    const code = block.querySelector("code");
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => {
      btn.textContent = "✅";
      setTimeout(() => { btn.textContent = "📋"; }, 1500);
    }).catch(() => {});
  };
}

// ── Deep DOM query ─────────────────────────────────────────────────────────
function querySelectorAllDeep(selector, root = document) {
  const results = [];
  function search(node) {
    results.push(...node.querySelectorAll(selector));
    for (const el of node.querySelectorAll("*")) { if (el.shadowRoot) search(el.shadowRoot); }
  }
  search(root);
  return results;
}

function isUsableElement(el) {
  if (!el?.isConnected) return false;
  const style = window.getComputedStyle?.(el);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  const rect = el.getBoundingClientRect?.();
  return !rect || rect.width > 0 || rect.height > 0;
}

function activeElement(selector) {
  const all = querySelectorAllDeep(selector).filter(el => el?.isConnected);
  const usable = all.filter(isUsableElement);
  return usable[usable.length - 1] ?? all[all.length - 1] ?? null;
}

function activeElements(selector) {
  const all = querySelectorAllDeep(selector).filter(el => el?.isConnected);
  const usable = all.filter(isUsableElement);
  return usable.length > 0 ? usable : all;
}

// ── Panel context helper ──────────────────────────────────────────────────
function getPanelContext() { return panelContext; }

// ── Toast ─────────────────────────────────────────────────────────────────
function showToast(message, duration = 3500) {
  let container = document.querySelector(".dv-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "dv-toast-container";
    container.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:999999;display:flex;flex-direction:column;gap:8px;";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.cssText = "padding:10px 14px;border-radius:8px;background:var(--pi-surface,#161b22);border:1px solid var(--pi-border,#30363d);color:var(--pi-text,#c9d1d9);box-shadow:0 4px 20px rgba(0,0,0,.35);max-width:380px;font-size:13px;";
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ── Toolbar state ──────────────────────────────────────────────────────────
function updateToolbarState() {
  const editBtns = querySelectorAllDeep('[data-action="edit"]');
  const saveBtns = querySelectorAllDeep('[data-action="save"]');
  const cancelBtns = querySelectorAllDeep('[data-action="cancel-edit"]');
  const copyBtns = querySelectorAllDeep('[data-action="copy-path"]');
  const copyContentBtns = querySelectorAllDeep('[data-action="copy-content"]');
  const searchInputs = querySelectorAllDeep(".dv-toolbar-search");
  const noFile = !currentFile;

  if (mode === "edit") {
    editBtns.forEach(b => { b.style.display = "none"; });
    saveBtns.forEach(b => { b.style.display = "inline-flex"; });
    cancelBtns.forEach(b => { b.style.display = "inline-flex"; });
    copyBtns.forEach(b => { b.disabled = true; b.classList.add("disabled"); });
    copyContentBtns.forEach(b => { b.disabled = true; b.classList.add("disabled"); });
    searchInputs.forEach(i => { i.disabled = true; i.style.opacity = "0.5"; });
  } else {
    editBtns.forEach(b => { b.style.display = "inline-flex"; b.disabled = noFile; b.classList.toggle("disabled", noFile); });
    saveBtns.forEach(b => { b.style.display = "none"; });
    cancelBtns.forEach(b => { b.style.display = "none"; });
    copyBtns.forEach(b => { b.disabled = noFile; b.classList.toggle("disabled", noFile); });
    copyContentBtns.forEach(b => { b.disabled = noFile; b.classList.toggle("disabled", noFile); });
    searchInputs.forEach(i => { i.disabled = false; i.style.opacity = ""; });
  }
}

function makeTreeSignature(tree) {
  const collapsed = [...collapsedDirs].sort().join(",");
  const files = (tree ?? []).map(f => `${f.path}:${fileTitles.get(f.path) ?? ""}`).join("|");
  return `${fileTreeKey ?? ""}::${collapsed}::${files}`;
}

function updateSidebarActive() {
  const sidebars = querySelectorAllDeep(".doc-viewer-file-list");
  for (const sidebar of sidebars) {
    for (const item of sidebar.querySelectorAll("li")) {
      item.classList.toggle("active", item.dataset.path === currentFile);
    }
  }
}

function applyFocusMode() {
  const isFocus = viewMode === "focus";
  querySelectorAllDeep(".dv-toolbar").forEach(toolbar => {
    const section = toolbar.closest("section.toolbar");
    if (section) section.classList.toggle("doc-viewer-focus-toolbar", isFocus);
    const focusBtn = toolbar.querySelector('[data-action="focus"]');
    if (focusBtn) {
      focusBtn.innerHTML = iconSvg(isFocus ? "collapse" : "expand");
      focusBtn.title = isFocus ? "Exit focus mode" : "Focus mode";
      focusBtn.setAttribute("aria-label", isFocus ? "Exit focus mode" : "Enter focus mode");
      focusBtn.classList.toggle("active", isFocus);
    }
  });
  querySelectorAllDeep(".doc-viewer-panel").forEach(panel => {
    panel.classList.toggle("doc-viewer-focus-panel", isFocus);
  });
  // Apply persisted sidebar width + wire resizer when entering focus mode
  if (isFocus) {
    applyPersistedSidebarWidth();
    wireResizer();
  } else {
    unwireResizer();
  }
}

// ── Resizable sidebar (focus/fullscreen mode) ────────────────────────────────
const SIDEBAR_WIDTH_KEY = "doc-viewer:sidebar-width";
const MIN_SIDEBAR_W = 180;
const MAX_SIDEBAR_RATIO = 0.6; // 60% of panel width
let resizerEl = null;
let resizerMoveHandler = null;
let resizerUpHandler = null;

function getPersistedSidebarWidth() {
  const v = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(v) && v >= MIN_SIDEBAR_W ? v : null;
}

function applyPersistedSidebarWidth() {
  const w = getPersistedSidebarWidth();
  if (!w) return;
  querySelectorAllDeep(".doc-viewer-focus-panel .doc-viewer-layout").forEach(layout => {
    layout.style.setProperty("--dv-sidebar-w", w + "px");
  });
}

function unwireResizer() {
  if (resizerEl && resizerMoveHandler) {
    document.removeEventListener("mousemove", resizerMoveHandler);
    document.removeEventListener("mouseup", resizerUpHandler);
    resizerEl.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }
  resizerEl = null;
  resizerMoveHandler = null;
  resizerUpHandler = null;
}

function wireResizer() {
  const handle = activeElement(".dv-resizer");
  if (!handle || handle.dataset.wired === "true") return;
  handle.dataset.wired = "true";

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("dragging");
    resizerEl = handle;
    const layout = handle.closest(".doc-viewer-layout");
    const panel = handle.closest(".doc-viewer-panel");
    if (!layout || !panel) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const startX = e.clientX;
    const startW = layout.querySelector(".doc-viewer-sidebar").getBoundingClientRect().width;

    resizerMoveHandler = (ev) => {
      const delta = ev.clientX - startX;
      const maxW = panel.getBoundingClientRect().width * MAX_SIDEBAR_RATIO;
      const newW = Math.max(MIN_SIDEBAR_W, Math.min(startW + delta, maxW));
      layout.style.setProperty("--dv-sidebar-w", newW + "px");
    };
    resizerUpHandler = () => {
      handle.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const w = layout.querySelector(".doc-viewer-sidebar").getBoundingClientRect().width;
      if (w >= MIN_SIDEBAR_W) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(w)));
      document.removeEventListener("mousemove", resizerMoveHandler);
      document.removeEventListener("mouseup", resizerUpHandler);
      resizerEl = null;
      resizerMoveHandler = null;
      resizerUpHandler = null;
    };
    document.addEventListener("mousemove", resizerMoveHandler);
    document.addEventListener("mouseup", resizerUpHandler);
  });
}

function toggleFocusMode() {
  viewMode = viewMode === "focus" ? "normal" : "focus";
  applyFocusMode();
}

// ── Styles — Premium dark theme coherent with pi-web ────────────────────────
const CSS = `
.doc-viewer-panel{box-sizing:border-box;padding:12px!important;overflow-y:auto!important;display:block!important;min-height:0!important}
.doc-viewer-layout{display:block;min-height:0;overflow:visible;border:1px solid var(--pi-border,#30363d);border-radius:12px;background:var(--pi-surface,#0d1117)}

/* ── Toolbar — inside pi-web native section.toolbar ──────────────────────── */
.dv-toolbar{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box}
.dv-toolbar-left{display:flex;align-items:center;gap:8px;flex:1;min-width:120px;background:rgba(255,255,255,.03);border:1px solid var(--pi-border,#30363d);border-radius:10px;padding:0 10px;height:36px;box-sizing:border-box}
.dv-toolbar-icon{display:inline-flex;align-items:center;justify-content:center;color:var(--pi-muted,#8b949e);width:18px;height:18px;flex-shrink:0}
.dv-toolbar-icon svg,.dv-toolbar-btn svg,.doc-viewer-sidebar-title svg,.doc-viewer-file-list svg,.doc-viewer-empty svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.dv-toolbar-search{flex:1;min-width:0;height:32px;padding:0;font-size:13px;color:var(--pi-text,#c9d1d9);background:transparent;border:0;outline:none}
.dv-toolbar-search::placeholder{color:var(--pi-muted,#8b949e)}
.dv-toolbar-left:focus-within{border-color:var(--pi-accent,#58a6ff);box-shadow:0 0 0 2px rgba(124,58,237,.18)}
.dv-toolbar-right{display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:auto}
.dv-toolbar-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;min-width:40px;padding:0 11px;font-size:13px;font-weight:650;color:var(--pi-text,#c9d1d9);background:rgba(20,27,46,.72);border:1px solid var(--pi-border,#30363d);border-radius:10px;cursor:pointer;opacity:1;transition:background .15s ease,border-color .15s ease,color .15s ease,transform .1s ease,box-shadow .15s ease;white-space:nowrap;box-sizing:border-box}
.dv-toolbar-btn:hover{background:rgba(124,58,237,.12);border-color:var(--pi-accent,#8b5cf6);box-shadow:0 0 0 1px rgba(124,58,237,.15)}
.dv-toolbar-btn:active{transform:scale(.96)}
.dv-toolbar-btn:disabled,.dv-toolbar-btn.disabled{opacity:.38;pointer-events:none;cursor:default}
.dv-toolbar-btn--primary{background:rgba(20,184,166,.12);color:#22d3c5;border-color:rgba(20,184,166,.5)}
.dv-toolbar-btn--primary:hover{background:rgba(20,184,166,.22);border-color:#14b8a6;color:#dffdfa}
.dv-toolbar-btn--danger{background:rgba(248,81,73,.08);color:var(--pi-error,#f85149);border-color:rgba(248,81,73,.45)}
.dv-toolbar-btn--danger:hover{background:rgba(248,81,73,.18);border-color:var(--pi-error,#f85149);color:#ffd7d5}
.dv-toolbar-btn.active{background:rgba(124,58,237,.18);border-color:var(--pi-accent,#8b5cf6);color:var(--pi-text,#c9d1d9);box-shadow:0 0 0 1px rgba(124,58,237,.18)}
.dv-toolbar-btn.spinning svg{animation:dv-spin .7s linear infinite}
@media (max-width:420px){.dv-toolbar{flex-wrap:wrap}.dv-toolbar-left{flex-basis:100%}.dv-toolbar-right{width:100%;justify-content:flex-start}}

/* ── Focus mode: CSS overlay only, no browser fullscreen ─────────────────── */
section.toolbar.doc-viewer-focus-toolbar{position:fixed!important;left:0!important;right:0!important;top:0!important;height:64px!important;z-index:2147483000!important;padding:10px 14px!important;background:var(--pi-bg,#05070d)!important;border-bottom:1px solid var(--pi-border,#30363d)!important;box-sizing:border-box!important}
section.viewer.doc-viewer-focus-panel{position:fixed!important;left:0!important;right:0!important;top:64px!important;bottom:0!important;z-index:2147482999!important;width:auto!important;height:auto!important;max-height:none!important;padding:14px!important;background:var(--pi-bg,#05070d)!important;box-sizing:border-box!important;overflow:hidden!important}
.doc-viewer-focus-panel .doc-viewer-layout{display:grid;grid-template-columns:var(--dv-sidebar-w,minmax(260px,25%)) 7px minmax(0,1fr);height:100%;overflow:hidden}
.doc-viewer-focus-panel .doc-viewer-sidebar{border-right:0;border-bottom:0;overflow-y:auto;min-height:0}
.dv-resizer{display:none}
.doc-viewer-focus-panel .dv-resizer{display:block;cursor:col-resize;background:var(--pi-border,#30363d);position:relative;z-index:2;transition:background .15s ease}
.doc-viewer-focus-panel .dv-resizer:hover,.doc-viewer-focus-panel .dv-resizer.dragging{background:var(--pi-accent,#8b5cf6)}
.doc-viewer-focus-panel .dv-resizer::after{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:3px;height:28px;border-radius:2px;background:var(--pi-muted,#8b949e);opacity:.5}
.doc-viewer-focus-panel .dv-resizer:hover::after,.doc-viewer-focus-panel .dv-resizer.dragging::after{opacity:1}
.doc-viewer-focus-panel .dv-resizer{user-select:none;-webkit-user-select:none}
.doc-viewer-focus-panel .doc-viewer-content-wrap{overflow-y:auto;min-height:0;background:#0b1020;padding:24px 34px}
.doc-viewer-focus-panel .doc-viewer-content{padding:42px 56px;max-width:1180px;min-height:calc(100vh - 112px)}

/* ── Sidebar ──────────────────────────────────────────────────────────────── */
.doc-viewer-sidebar{border-bottom:1px solid var(--pi-border,#30363d);padding:0 10px 10px;background:var(--pi-surface,#0d1117)}
.doc-viewer-sidebar-title{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;padding:11px 2px 7px;color:var(--pi-text,#c9d1d9);position:sticky;top:0;background:var(--pi-surface,#0d1117);z-index:1;cursor:pointer;user-select:none}
.doc-viewer-file-list{list-style:none;padding:0;margin:0}
.doc-viewer-file-list li{padding:6px 10px 6px var(--indent,10px);cursor:pointer;border-radius:8px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .12s ease,color .12s ease,border-color .12s ease;color:var(--pi-text,#c9d1d9);margin-bottom:2px;display:flex;align-items:center;gap:8px;border:1px solid transparent}
.doc-viewer-file-list li:hover{background:rgba(255,255,255,.04);border-color:var(--pi-border,#30363d)}
.doc-viewer-file-list li.active{background:rgba(124,58,237,.12);border-color:rgba(124,58,237,.45);color:var(--pi-text,#c9d1d9);font-weight:650;box-shadow:inset 3px 0 0 var(--pi-accent,#8b5cf6)}
.doc-viewer-file-list li.active .file-name{color:var(--pi-text,#c9d1d9)}
.doc-viewer-file-list li.active .file-icon{color:var(--pi-accent,#a78bfa)}
.doc-viewer-file-list li.doc-viewer-dir{cursor:pointer;margin-top:7px;color:var(--pi-muted,#8b949e);font-weight:700;text-transform:none;background:transparent;border-color:transparent;opacity:.95;user-select:none}
.doc-viewer-file-list li.doc-viewer-dir:hover{background:rgba(255,255,255,.03);border-color:transparent;color:var(--pi-text,#c9d1d9)}
.folder-toggle{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;color:var(--pi-muted,#8b949e);flex:0 0 14px}
.folder-toggle svg{width:14px!important;height:14px!important}
.folder-toggle.spacer{visibility:hidden}
.doc-viewer-file-list li.nested{padding-left:24px}
.doc-viewer-file-list li .file-icon{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;opacity:.85}
.doc-viewer-file-list li .file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doc-viewer-loading-row{color:var(--pi-muted,#8b949e)!important;cursor:default!important}

/* ── Content card ────────────────────────────────────────────────────────── */
.doc-viewer-content-wrap{padding:18px 22px;background:#0b1020}
.doc-viewer-content{--dv-paper-bg:#ffffff;--dv-paper-text:#1f2937;--dv-paper-muted:#667085;--dv-paper-border:#d7dce3;--dv-paper-soft:#f6f8fa;--dv-paper-softer:#fbfcfe;--dv-paper-accent:#2563eb;--dv-paper-accent-soft:#eff6ff;background:var(--dv-paper-bg);border:1px solid rgba(15,23,42,.14);border-radius:10px;padding:34px 42px;font-size:15px;line-height:1.75;color:var(--dv-paper-text);box-shadow:0 14px 40px rgba(0,0,0,.28);min-height:calc(100vh - 250px);max-width:1120px;margin:0 auto;box-sizing:border-box}

/* Empty state */
.doc-viewer-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;opacity:.75;text-align:center;padding:40px;color:var(--dv-paper-muted,var(--pi-muted,#8b949e))}
.doc-viewer-empty .big-icon{font-size:44px;margin-bottom:14px}

/* Headings */
.doc-viewer-content h1{font-size:1.9em;font-weight:760;margin:.45em 0 .55em;padding-bottom:.35em;border-bottom:2px solid var(--dv-paper-border);color:#111827;line-height:1.22;letter-spacing:-.02em}
.doc-viewer-content h2{font-size:1.48em;font-weight:720;margin:1.15em 0 .45em;padding-bottom:.25em;border-bottom:1px solid var(--dv-paper-border);color:#111827;line-height:1.3}
.doc-viewer-content h3{font-size:1.22em;font-weight:680;margin:1em 0 .3em;color:#1d4ed8;line-height:1.35}
.doc-viewer-content h4{font-size:1.08em;font-weight:650;margin:.8em 0 .25em;color:#111827;line-height:1.35}
.doc-viewer-content h5,.doc-viewer-content h6{font-size:1em;font-weight:650;margin:.7em 0 .2em;color:var(--dv-paper-muted);line-height:1.35;text-transform:uppercase;letter-spacing:.04em}

/* Paragraphs & text */
.doc-viewer-content p{margin:.75em 0;color:var(--dv-paper-text);line-height:1.75}
.doc-viewer-content a{color:var(--dv-paper-accent);text-decoration:none;transition:opacity .12s ease}
.doc-viewer-content a:hover{text-decoration:underline;opacity:.85}
.doc-viewer-content img{max-width:100%;border-radius:8px;border:1px solid var(--dv-paper-border);box-shadow:0 2px 12px rgba(15,23,42,.12);transition:transform .15s ease}
.doc-viewer-content img:hover{transform:scale(1.01)}
.doc-viewer-content ul,.doc-viewer-content ol{padding-left:1.7em;margin:.7em 0}
.doc-viewer-content li{margin:.38em 0;color:var(--dv-paper-text);line-height:1.65}
.doc-viewer-content li::marker{color:var(--dv-paper-accent)}

/* Blockquote */
.doc-viewer-content blockquote{border-left:4px solid var(--dv-paper-accent);padding:.85em 1.2em;margin:1em 0;background:var(--dv-paper-accent-soft);border-radius:0 8px 8px 0;color:#374151;font-style:italic}
.doc-viewer-content blockquote p{margin:.3em 0;color:#374151}

/* Horizontal rule */
.doc-viewer-content hr{border:none;border-top:1px solid var(--dv-paper-border);margin:1.8em 0;position:relative}
.doc-viewer-content hr::after{content:"";display:block;width:44px;height:2px;background:var(--dv-paper-accent);border-radius:1px;margin:-1.5px auto 0;opacity:.28}

/* Inline code */
.doc-viewer-content code{background:#f1f5f9;padding:2px 6px;border-radius:5px;font-size:.88em;color:#9a3412;border:1px solid #d8dee8;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;white-space:nowrap}

/* Code blocks — PREMIUM */
.doc-viewer-code-block{position:relative;margin:1.15em 0;border-radius:10px;overflow:hidden;background:#f8fafc;border:1px solid var(--dv-paper-border);box-shadow:0 4px 14px rgba(15,23,42,.10)}
.doc-viewer-code-block .code-header{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%);border-bottom:1px solid var(--dv-paper-border)}
.doc-viewer-code-block .code-lang{font-size:11.5px;color:var(--dv-paper-muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700;font-family:'SFMono-Regular',Consolas,monospace}
.doc-viewer-code-block .code-copy-btn{background:#fff;border:1px solid var(--dv-paper-border);border-radius:5px;cursor:pointer;font-size:13px;padding:3px 8px;opacity:.72;transition:opacity .15s ease,background .15s ease,color .15s ease;color:#334155}
.doc-viewer-code-block .code-copy-btn:hover{opacity:1;background:#eef2ff;color:#1d4ed8}
.doc-viewer-code-block pre{margin:0;padding:14px 18px;overflow:auto;max-height:min(62vh,720px);font-size:13px;line-height:1.6;color:#111827;background:#f8fafc;white-space:pre;tab-size:2}
.doc-viewer-code-block code{display:block;width:max-content;min-width:100%;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;color:#111827;background:transparent;border:none;padding:0;font-size:inherit;white-space:pre!important;line-height:inherit}
.doc-viewer-code-block pre::-webkit-scrollbar{width:8px;height:8px}
.doc-viewer-code-block pre::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:4px}
.doc-viewer-code-block pre::-webkit-scrollbar-corner{background:#f8fafc}

/* Mermaid */
.doc-viewer-mermaid{margin:1.35em 0;text-align:center;background:#ffffff;padding:18px;border-radius:10px;border:1px solid var(--dv-paper-border);box-shadow:0 4px 16px rgba(15,23,42,.10);color:#111827}
.doc-viewer-mermaid .mermaid-render{color:#111827;background:#ffffff}
.doc-viewer-mermaid .mermaid-render svg{max-width:100%;height:auto;color:#111827;background:#ffffff}
.mermaid-loading{padding:28px;color:var(--dv-paper-muted);font-size:14px}
.doc-viewer-mermaid .mermaid-source{text-align:left;margin:10px 0 0;padding:12px;background:#f8fafc;border-radius:6px;font-size:12px;opacity:.85;white-space:pre-wrap;word-break:break-all;color:#111827;border:1px solid var(--dv-paper-border)}

/* Tables — data-grid look */
.doc-viewer-table{width:100%;border-collapse:separate;border-spacing:0;margin:1em 0;font-size:13.5px;border:1px solid var(--dv-paper-border);border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,.08)}
.doc-viewer-table th,.doc-viewer-table td{border-bottom:1px solid var(--dv-paper-border);border-right:1px solid var(--dv-paper-border);padding:9px 14px;color:var(--dv-paper-text);text-align:left}
.doc-viewer-table th:last-child,.doc-viewer-table td:last-child{border-right:none}
.doc-viewer-table tr:last-child td{border-bottom:none}
.doc-viewer-table th{background:linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%);font-weight:700;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:#475569}
.doc-viewer-table tr:hover td{background:#f8fbff}

/* Search results */
.dv-search{padding:8px}
.dv-search-meta{font-size:13px;color:var(--dv-paper-muted);margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--dv-paper-border)}
.dv-search-result{margin-bottom:16px;padding:12px 16px;border-radius:8px;background:#ffffff;border:1px solid var(--dv-paper-border);transition:border-color .15s ease,box-shadow .15s ease;cursor:pointer;box-shadow:0 2px 8px rgba(15,23,42,.06)}
.dv-search-result:hover{border-color:var(--dv-paper-accent);box-shadow:0 4px 14px rgba(37,99,235,.12)}
.dv-search-result-title{margin:0 0 6px;font-size:15px;font-weight:650}
.dv-search-result-title a{color:var(--dv-paper-accent);text-decoration:none;cursor:pointer}
.dv-search-result-title a:hover{text-decoration:underline}
.dv-search-result-snippet{margin:0 0 8px;font-size:13.5px;line-height:1.6;color:var(--dv-paper-text)}
.dv-highlight{background:#fef3c7;color:#92400e;padding:1px 3px;border-radius:3px;font-weight:700}
.dv-search-result-path{font-size:12px;color:var(--dv-paper-muted);font-family:'SFMono-Regular',Consolas,monospace}
.dv-muted{color:var(--dv-paper-muted,var(--pi-muted,#8b949e))}

/* Editor */
.doc-viewer-content.editing{padding:0!important;background:var(--pi-surface,#0d1117)!important}
.dv-editor{display:block;box-sizing:border-box;width:100%;height:70vh;min-height:420px;padding:16px 20px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:14px;line-height:1.6;color:var(--pi-text,#c9d1d9);background:var(--pi-surface,#0d1117);border:none;outline:none;resize:vertical;tab-size:2;overflow:auto;white-space:pre}
.doc-viewer-focus-panel .dv-editor{height:calc(100vh - 112px);min-height:calc(100vh - 112px);resize:none}
.dv-editor:focus{outline:none;box-shadow:inset 0 0 0 1px var(--pi-accent,#58a6ff)}

/* Toast */
.dv-toast-container{position:fixed;right:16px;bottom:16px;z-index:999999;display:flex;flex-direction:column;gap:8px}

/* Scrollbars */
.doc-viewer-panel::-webkit-scrollbar{width:6px}
.doc-viewer-panel::-webkit-scrollbar-thumb{background:var(--pi-border,#30363d);border-radius:3px}
.doc-viewer-code-block pre::-webkit-scrollbar{height:6px}
.doc-viewer-code-block pre::-webkit-scrollbar-thumb{background:var(--pi-border,#30363d);border-radius:3px}

@keyframes dv-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
`;

// ── Plugin ────────────────────────────────────────────────────────────────

let cleanupHook = null;

const plugin = {
  apiVersion: 2,
  name: "Doc Viewer",

  activate: ({ html, svg, runtimePluginId }) => {
    // Styles are scoped inside the panel template. Remove stale global CSS from older builds
    // so doc-viewer cannot affect other pi-web panels such as Terminal.
    document.getElementById("doc-viewer-styles")?.remove();
    return {
      deactivate: () => {
        cancelPendingRenders();
        cancelMermaidPoller();
        unwireToolbar();
        unwireResizer();
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
        fileTree = null; fileTreeKey = null; currentFile = null;
        renderedFiles.clear(); fileContents.clear(); fileTitles.clear();
        editBackup = null; editDraft = null; mode = "view"; viewMode = "normal";
        mermaidReady = false; mermaidLoading = false;
        // Remove toast container
        document.querySelector(".dv-toast-container")?.remove();
        // Remove stale global copy handler
        delete window.docViewerCopyCode;
        // Remove mermaid script if we loaded it
        document.querySelector('script[src*="mermaid"]')?.remove();
        panelContext = null;
      },
      contributions: {
        actions: [
          {
            id: "open-docs",
            title: "Open Documentation Viewer",
            description: "Browse and render markdown files from the workspace docs/ folder",
            shortcut: "mod+shift+d",
            group: "Docs",
            enabled: (context) => context.state?.selectedWorkspace !== undefined,
            run: (context) => {
              context.selectWorkspaceTool(`${runtimePluginId}:docs`);
            },
          },
        ],

        workspacePanels: [
          {
            id: "docs",
            routeAliases: ["doc-viewer:docs"],
            title: "Docs",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
            `,
            order: 8500,
            badge: (context) => {
              if (!fileTree || treeKey(context) !== fileTreeKey) return undefined;
              return fileTree.length > 0 ? String(fileTree.length) : undefined;
            },
            render: (context) => {
              panelContext = context;

              const key = treeKey(context);
              if (fileTreeKey !== null && fileTreeKey !== key) {
                fileTree = null;
                fileTreeKey = null;
                currentFile = null;
                fileTitles.clear();
                renderedFiles.clear();
                fileContents.clear();
                editBackup = null;
                editDraft = null;
                mode = "view";
                if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
              }

              const hasTree = fileTree !== null;

              if (!hasTree && !treeFetchPromise) {
                const fetchKey = key;
                treeFetchPromise = fetchDocsTree(context).finally(() => {
                  treeFetchPromise = null;
                  if (!panelContext || treeKey(panelContext) !== fetchKey) return;
                  requestAnimationFrame(() => renderPanelDOM(panelContext));
                });
              }

              // Cancel any previously scheduled renders and schedule fresh ones.
              cancelPendingRenders();
              const renderKey = key;
              const schedulePanelRender = () => {
                if (!panelContext || treeKey(panelContext) !== renderKey) return;
                renderPanelDOM(panelContext);
              };
              scheduleRender(schedulePanelRender);

              return html`
                <style>${CSS}</style>
                <section class="toolbar">
                  <div class="dv-toolbar">
                    <div class="dv-toolbar-left">
                      <span class="dv-toolbar-icon"></span>
                      <input class="dv-toolbar-search" type="text" placeholder="Search docs…" spellcheck="false" />
                    </div>
                    <div class="dv-toolbar-right">
                      <button class="dv-toolbar-btn" data-action="refresh" title="Refresh file tree" aria-label="Refresh file tree"></button>
                      <button class="dv-toolbar-btn" data-action="copy-path" title="Copy full file path" aria-label="Copy full file path" disabled></button>
                      <button class="dv-toolbar-btn" data-action="copy-content" title="Copy file content" aria-label="Copy file content" disabled></button>
                      <button class="dv-toolbar-btn" data-action="edit" title="Edit file" aria-label="Edit file" disabled></button>
                      <button class="dv-toolbar-btn" data-action="focus" title="Focus mode" aria-label="Toggle focus mode"></button>
                      <button class="dv-toolbar-btn dv-toolbar-btn--primary" data-action="save" title="Save changes" aria-label="Save changes" style="display:none;"></button>
                      <button class="dv-toolbar-btn dv-toolbar-btn--danger" data-action="cancel-edit" title="Discard edits" aria-label="Discard edits" style="display:none;"></button>
                    </div>
                  </div>
                </section>
                <section class="viewer doc-viewer-panel">
                  <div class="doc-viewer-layout">
                    <div class="doc-viewer-sidebar">
                      <div class="doc-viewer-sidebar-title"></div>
                      <ul class="doc-viewer-file-list"></ul>
                    </div>
                    <div class="dv-resizer" data-action="resize-sidebar" title="Drag to resize" aria-label="Resize sidebar"></div>
                    <div class="doc-viewer-content-wrap">
                      <div class="doc-viewer-content"></div>
                    </div>
                  </div>
                </section>
              `;
            },
          },
        ],
      },
    };
  },
};

// ── DOM-based panel updates ─────────────────────────────────────────────

function renderPanelDOM(context) {
  const sidebar = activeElement(".doc-viewer-file-list");
  const content = activeElement(".doc-viewer-content");

  if (!sidebar || !content) return;

  // Wire toolbar only once (guarded inside wireToolbar by dataset.wired)
  wireToolbar(context);
  // Apply focus mode CSS classes
  applyFocusMode();

  activeElements(".doc-viewer-sidebar-title").forEach(el => {
    const collapsed = collapsedDirs.has("docs");
    el.classList.toggle("collapsed", collapsed);
    el.innerHTML = `<span class="folder-toggle">${iconSvg(collapsed ? "chevron-right" : "chevron-down")}</span><span class="file-icon">${iconSvg("folder")}</span><span>docs/</span>`;
    el.onclick = () => {
      if (collapsedDirs.has("docs")) collapsedDirs.delete("docs");
      else collapsedDirs.add("docs");
      renderPanelDOM(context);
    };
  });

  if (fileTree === null) {
    sidebar.innerHTML = `<li class="doc-viewer-loading-row"><span class="file-icon">${iconSvg("folder")}</span><span class="file-name">Loading docs…</span></li>`;
    content.innerHTML = `<div class="doc-viewer-empty"><div class="big-icon">${iconSvg("folder")}</div><p>Loading docs…</p></div>`;
    updateToolbarState();
    return;
  }

  const tree = fileTree ?? [];

  if (tree.length === 0) {
    sidebar.innerHTML = "";
    content.innerHTML = `
      <div class="doc-viewer-empty">
        <div class="big-icon">${iconSvg("folder")}</div>
        <p><strong>No docs/ folder found</strong></p>
        <p class="muted" style="color:var(--pi-muted,#8b949e);">Create a <code>docs/</code> directory with <code>.md</code> files in this workspace.</p>
        <p style="margin-top:8px;color:var(--pi-muted,#8b949e);">${context.machine.name} · ${context.workspace.path}</p>
      </div>
    `;
    updateToolbarState();
    return;
  }

  const treeSignature = makeTreeSignature(tree);
  if (sidebar.dataset.treeSignature === treeSignature) {
    updateSidebarActive();
    updateToolbarState();
    renderFileContent(context);
    return;
  }
  sidebar.dataset.treeSignature = treeSignature;
  sidebar.innerHTML = "";
  const root = buildDirectoryTree(tree);

  const appendFile = (f, depth) => {
    const li = document.createElement("li");
    li.dataset.path = f.path;
    li.className = "doc-viewer-file";
    li.style.setProperty("--indent", `${10 + depth * 22}px`);
    li.style.display = "flex";
    li.style.alignItems = "center";
    const icon = iconSvg(fileIcon(f));
    const name = displayName(f);
    li.innerHTML = `<span class="folder-toggle spacer"></span><span class="file-icon">${icon}</span><span class="file-name" title="${escapeHtml(f.path)}">${escapeHtml(name)}</span>`;
    if (currentFile === f.path) li.classList.add("active");
    li.onclick = () => {
      if (mode === "edit") return;
      currentFile = f.path;
      updateSidebarActive();
      updateToolbarState();
      if (mode === "search") {
        const inputs = querySelectorAllDeep(".dv-toolbar-search");
        inputs.forEach(i => { i.value = ""; });
        mode = "view";
      }
      renderFileContent(context);
    };
    if (f.path.startsWith("docs/tmp/")) {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "dv-file-delete";
      deleteBtn.title = `Delete ${f.path}`;
      deleteBtn.innerHTML = iconSvg("trash");
      deleteBtn.style.cssText = "margin-left:auto;background:transparent;border:0;color:var(--pi-muted,#8b949e);cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;align-items:center;";
      deleteBtn.onmouseenter = () => { deleteBtn.style.color = "var(--pi-error,#f85149)"; };
      deleteBtn.onmouseleave = () => { deleteBtn.style.color = "var(--pi-muted,#8b949e)"; };
      deleteBtn.onclick = (event) => {
        event.stopPropagation();
        void deleteDocFile(f.path, context);
      };
      li.appendChild(deleteBtn);
    }
    sidebar.appendChild(li);
  };

const sortFiles = files => files.sort((a, b) => {
    const aIsIndex = a.name.toLowerCase() === "index.md";
    const bIsIndex = b.name.toLowerCase() === "index.md";
    if (aIsIndex && !bIsIndex) return -1;
    if (!aIsIndex && bIsIndex) return 1;
    return displayName(a).localeCompare(displayName(b));
  });

  const appendDirectory = (node, depth) => {
    const isCollapsed = collapsedDirs.has(node.path);
    const dirLi = document.createElement("li");
    dirLi.className = "doc-viewer-dir" + (isCollapsed ? " collapsed" : "");
    dirLi.dataset.dir = node.path;
    dirLi.style.setProperty("--indent", `${10 + depth * 22}px`);
    dirLi.innerHTML = `<span class="folder-toggle">${iconSvg(isCollapsed ? "chevron-right" : "chevron-down")}</span><span class="file-icon">${iconSvg("folder")}</span><span class="file-name">${escapeHtml(displayDirName(node.path))}</span>`;
    dirLi.onclick = () => {
      if (collapsedDirs.has(node.path)) collapsedDirs.delete(node.path);
      else collapsedDirs.add(node.path);
      renderPanelDOM(context);
    };
    sidebar.appendChild(dirLi);

    if (isCollapsed) return;

    for (const f of sortFiles(node.files)) appendFile(f, depth + 1);

    const children = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) appendDirectory(child, depth + 1);
  };

  if (!collapsedDirs.has(DOCS_DIR)) {
    for (const f of sortFiles(root.files)) appendFile(f, 0);
    const children = [...root.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) appendDirectory(child, 0);
  }

  updateToolbarState();
  renderFileContent(context);
}

// ── Toolbar wiring with cleanup tracking ───────────────────────────────────
let wiredToolbarEl = null;
let toolbarClickHandler = null;
let toolbarSearchInputHandler = null;
let toolbarSearchKeydownHandler = null;

function unwireToolbar() {
  if (!wiredToolbarEl) return;
  if (toolbarClickHandler) wiredToolbarEl.removeEventListener("click", toolbarClickHandler);
  const input = wiredToolbarEl.querySelector(".dv-toolbar-search");
  if (input) {
    if (toolbarSearchInputHandler) input.removeEventListener("input", toolbarSearchInputHandler);
    if (toolbarSearchKeydownHandler) input.removeEventListener("keydown", toolbarSearchKeydownHandler);
  }
  wiredToolbarEl.dataset.wired = "";
  wiredToolbarEl = null;
  toolbarClickHandler = null;
  toolbarSearchInputHandler = null;
  toolbarSearchKeydownHandler = null;
}

function wireToolbar(context) {
  const toolbars = querySelectorAllDeep(".dv-toolbar");
  for (const toolbar of toolbars) {
    const iconSlot = toolbar.querySelector(".dv-toolbar-icon");
    if (iconSlot && !iconSlot.innerHTML) iconSlot.innerHTML = iconSvg("search");
    const refreshBtn = toolbar.querySelector('[data-action="refresh"]');
    const copyBtn = toolbar.querySelector('[data-action="copy-path"]');
    const copyContentBtn = toolbar.querySelector('[data-action="copy-content"]');
    const editBtn = toolbar.querySelector('[data-action="edit"]');
    const saveBtn = toolbar.querySelector('[data-action="save"]');
    const cancelBtn = toolbar.querySelector('[data-action="cancel-edit"]');
    const focusBtn = toolbar.querySelector('[data-action="focus"]');
    if (refreshBtn && !refreshBtn.innerHTML) refreshBtn.innerHTML = iconSvg("refresh");
    if (copyBtn && !copyBtn.innerHTML) copyBtn.innerHTML = iconSvg("copy-path");
    if (copyContentBtn && !copyContentBtn.innerHTML) copyContentBtn.innerHTML = iconSvg("copy-content");
    if (editBtn && !editBtn.innerHTML) editBtn.innerHTML = iconSvg("edit");
    if (focusBtn) focusBtn.innerHTML = iconSvg(viewMode === "focus" ? "collapse" : "expand");
    if (saveBtn && !saveBtn.innerHTML) saveBtn.innerHTML = iconSvg("save") + '<span>Save</span>';
    if (cancelBtn && !cancelBtn.innerHTML) cancelBtn.innerHTML = iconSvg("cancel") + '<span>Cancel</span>';

    if (toolbar.dataset.wired === "true") continue;

    // Unwire previous toolbar if any
    unwireToolbar();
    toolbar.dataset.wired = "true";
    wiredToolbarEl = toolbar;

    // Search input: 300ms debounce
    const searchInput = toolbar.querySelector(".dv-toolbar-search");
    if (searchInput) {
      toolbarSearchInputHandler = () => {
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        const query = searchInput.value.trim();
        if (query.length < 2) {
          if (mode === "search") {
            mode = "view";
            renderFileContent(getPanelContext());
          }
          return;
        }
        searchDebounceTimer = setTimeout(async () => {
          mode = "search";
          const activeContext = getPanelContext();
          const content = activeElement(".doc-viewer-content");
          if (content) {
            content.innerHTML = `<div class="dv-search"><div class="dv-search-meta">Searching…</div></div>`;
          }
          if (treeFetchPromise) await treeFetchPromise;
          if (!fileTree && activeContext) await fetchDocsTree(activeContext);
          await ensureAllFileContents(activeContext);
          const results = searchDocs(query);
          renderSearchResults(results, query);
        }, 300);
      };
      searchInput.addEventListener("input", toolbarSearchInputHandler);

      toolbarSearchKeydownHandler = (e) => {
        if (e.key === "Escape") {
          searchInput.value = "";
          if (mode === "search") {
            mode = "view";
            renderFileContent(getPanelContext());
          }
          searchInput.blur();
        }
      };
      searchInput.addEventListener("keydown", toolbarSearchKeydownHandler);
    }

    // Button clicks via event delegation
    toolbarClickHandler = async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn || btn.disabled || btn.classList.contains("disabled")) return;
      const action = btn.dataset.action;

      if (action === "refresh") {
        btn.classList.add("spinning");
        fileTree = null;
        fileTreeKey = null;
        currentFile = null;
        fileTitles.clear();
        renderedFiles.clear();
        fileContents.clear();
        editBackup = null;
        editDraft = null;
        mode = "view";
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        const inputs = querySelectorAllDeep(".dv-toolbar-search");
        inputs.forEach(i => { i.value = ""; });
        fetchDocsTree(getPanelContext()).then(() => {
          if (panelContext !== getPanelContext()) return;
          btn.classList.remove("spinning");
          renderPanelDOM(getPanelContext());
        });
      }

      if (action === "copy-path") {
        if (!currentFile) return;
        const fullPath = fullWorkspacePath(getPanelContext(), currentFile);
        navigator.clipboard.writeText(fullPath).then(() => {
          const original = btn.innerHTML;
          btn.textContent = "✓";
          setTimeout(() => { btn.innerHTML = original; }, 1500);
        }).catch(() => {});
      }

      if (action === "copy-content") {
        if (!currentFile) return;
        const activeContext = getPanelContext();
        const content = fileContents.get(currentFile) ?? await readFileContent(currentFile, activeContext);
        if (content === null || content === undefined) return;
        navigator.clipboard.writeText(content).then(() => {
          const original = btn.innerHTML;
          btn.textContent = "✓";
          setTimeout(() => { btn.innerHTML = original; }, 1500);
          showToast(`Copied ${currentFile}`);
        }).catch((error) => {
          console.warn("[doc-viewer] Copy content failed:", error);
          showToast("Copy failed", 4000);
        });
      }

      if (action === "focus") toggleFocusMode();
      if (action === "edit") enterEditMode();
      if (action === "save") saveEdit(context);
      if (action === "cancel-edit") cancelEdit();
    };
    toolbar.addEventListener("click", toolbarClickHandler);
  }
}

// ── Edit mode ──────────────────────────────────────────────────────────────
function enterEditMode() {
  if (!currentFile || mode === "edit") return;
  const raw = fileContents.get(currentFile);
  if (raw === undefined) return;
  editBackup = raw;
  editDraft = raw;
  mode = "edit";
  updateToolbarState();
  ensureEditModeMounted(true);
}

function ensureEditModeMounted(shouldFocus = false) {
  if (mode !== "edit") return;
  const contents = activeElements(".doc-viewer-content");
  if (contents.length === 0) return;
  const primary = activeElement(".doc-viewer-content") ?? contents[contents.length - 1];
  for (const content of contents) renderEditModeContent(content, shouldFocus && content === primary);
}

function renderEditModeContent(content, shouldFocus = false) {
  if (!content || mode !== "edit") return;
  content.classList.add("editing");
  const existing = content.querySelector(".dv-editor");
  if (existing) {
    editDraft = existing.value;
    if (shouldFocus) existing.focus();
    return;
  }

  content.dataset.contentSignature = `edit:${currentFile ?? ""}`;
  content.innerHTML = "";
  content.style.padding = "0";
  content.style.background = "var(--pi-surface, #0d1117)";
  const textarea = document.createElement("textarea");
  textarea.className = "dv-editor";
  textarea.value = editDraft ?? editBackup ?? "";
  textarea.spellcheck = false;
  textarea.wrap = "off";
  textarea.addEventListener("input", () => { editDraft = textarea.value; });
  content.appendChild(textarea);
  if (shouldFocus) textarea.focus();
}

async function saveEdit(context) {
  if (mode !== "edit" || !currentFile) return;
  const content = activeElement(".doc-viewer-content");
  if (!content) return;
  const textarea = content.querySelector(".dv-editor");
  const newContent = textarea ? textarea.value : editDraft;
  if (newContent === null || newContent === undefined) return;

  try {
    const contentText = newContent ?? "";
    await context.files.writeFile(currentFile, contentText);

    // Invalidate caches
    renderedFiles.delete(currentFile);
    fileContents.set(currentFile, contentText);
    editBackup = null;
    editDraft = null;
    mode = "view";
    updateToolbarState();
    showToast(`Saved ${currentFile}`);
    content.style.padding = "";
    content.style.background = "";
    content.classList.remove("editing");
    renderFileContent(context);
  } catch (err) {
    console.warn("[doc-viewer] Save failed:", err);
    showToast(`Save failed: ${err?.message ?? String(err)}`, 6000);
  }
}


async function deleteDocFile(path, context) {
  if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
  try {
    await context.files.deleteFile(path);
    fileTree = (fileTree ?? []).filter(f => f.path !== path);
    fileContents.delete(path);
    fileTitles.delete(path);
    renderedFiles.delete(path);
    if (currentFile === path) {
      currentFile = null;
      mode = "view";
    }
    showToast(`Deleted ${path}`);
    renderPanelDOM(context);
  } catch (err) {
    console.warn("[doc-viewer] Delete failed:", err);
    showToast(`Delete failed: ${err?.message ?? String(err)}`, 6000);
  }
}

function cancelEdit() {
  if (mode !== "edit") return;
  editBackup = null;
  editDraft = null;
  mode = "view";
  updateToolbarState();
  for (const content of activeElements(".doc-viewer-content")) {
    content.style.padding = "";
    content.style.background = "";
    content.classList.remove("editing");
  }
  renderFileContent(getPanelContext());
}

function renderFileContent(context) {
  const content = activeElement(".doc-viewer-content");
  if (!content) return;

  if (mode === "search") return;
  if (mode === "edit") {
    renderEditModeContent(content);
    return;
  }

  content.style.padding = "";
  content.style.background = "";
  content.classList.remove("editing");

  if (!currentFile) {
    const signature = "empty";
    if (content.dataset.contentSignature !== signature) {
      content.dataset.contentSignature = signature;
      content.innerHTML = `
        <div class="doc-viewer-empty" style="height:auto;padding:40px 24px;">
          <div class="big-icon" style="font-size:32px;">📄</div>
          <p style="margin-top:8px;color:var(--pi-muted,#8b949e);">Select a file from the list to view it</p>
        </div>
      `;
    }
    return;
  }

  const cached = renderedFiles.get(currentFile);
  if (cached) {
    const signature = `view:${currentFile}:${cached.length}`;
    if (content.dataset.contentSignature !== signature) {
      content.dataset.contentSignature = signature;
      content.innerHTML = cached;
      wireDocumentLinks(content, context);
      requestAnimationFrame(() => setTimeout(() => renderMermaidDiagrams(content), 50));
    }
    return;
  }

  const loadingSignature = `loading:${currentFile}`;
  if (content.dataset.contentSignature !== loadingSignature) {
    content.dataset.contentSignature = loadingSignature;
    content.innerHTML = '<p style="color:var(--pi-muted,#8b949e);">Loading…</p>';
    loadAndRenderFile(currentFile, context, content);
  }
}

async function loadAndRenderFile(path, context, contentEl) {
  const text = await readFileContent(path, context);
  if (text === null) {
    renderedFiles.set(path, '<p style="color:var(--pi-error,#f85149);">⚠️ Could not read file.</p>');
  } else {
    const rendered = renderMarkdown(text);
    renderedFiles.set(path, rendered);
    evictIfNeeded(renderedFiles, MAX_CACHE_SIZE);
  }

  if (currentFile !== path || mode !== "view") return;

  const el = activeElement(".doc-viewer-content") ?? contentEl;
  const rendered = renderedFiles.get(path);
  const signature = `view:${path}:${rendered?.length ?? 0}`;
  if (el.dataset.contentSignature !== signature) {
    el.dataset.contentSignature = signature;
    el.innerHTML = rendered;
    wireDocumentLinks(el, context);
    requestAnimationFrame(() => setTimeout(() => renderMermaidDiagrams(el), 50));
  }
}

export default plugin;