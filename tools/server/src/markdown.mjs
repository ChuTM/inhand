/**
 * markdown.mjs — configurable Markdown router for public pages.
 *
 * Mount a directory under markdowns/ and its files become pages:
 *
 *   const MD_ROUTES = [
 *     { route: "/legal", dir: "markdowns/legal", label: "Legal" },
 *     { route: "/blogs", dir: "markdowns/blogs", label: "Blogs" },
 *   ];
 *
 *   markdowns/legal/index.md        → GET /legal
 *   markdowns/legal/privacy.md      → GET /legal/privacy
 *   markdowns/blogs/example-usage.md→ GET /blogs/example-usage
 *   markdowns/blogs/foo/bar.md      → GET /blogs/foo/bar
 *
 * The renderer never trusts the Markdown (raw HTML is disabled), rewrites
 * internal `.md` links to public routes, collects h2/h3 headings for the
 * in-page section indicator, and renders documents immersively — content is
 * laid out directly on the page, not wrapped in a card.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import MarkdownIt from "markdown-it";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_ROOT = path.join(__dirname, "..");

// ---- Markdown route configuration (edit this list to mount new sections) ----
export const MD_ROUTES = [
	{ route: "/legal", dir: "markdowns/legal", label: "Legal" },
	{ route: "/blogs", dir: "markdowns/blogs", label: "Blogs" },
	{ route: "/docs", dir: "markdowns/docs", label: "Docs" },
	{ route: "/contact", dir: "markdowns/contact", label: "Contact" },
];

// Raw HTML is deliberately disabled: legal content must render as pure
// Markdown, so a compromised or edited source file can never inject markup.
const md = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: true,
});

// Collect headings while rendering and stamp each h2–h3 with a stable anchor
// id (sec-1, sec-2, …). The collected list drives the in-page section
// indicator on the right-hand side. env.headings is filled per render.
const defaultHeadingOpen =
	md.renderer.rules.heading_open ||
	((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
	const tok = tokens[idx];
	const level = Number(tok.tag.slice(1));
	if (level >= 2 && level <= 3) {
		const headingText = (tokens[idx + 1] && tokens[idx + 1].content || "").trim();
		if (headingText === "Contents") return defaultHeadingOpen(tokens, idx, options, env, self);
		env.headings = env.headings || [];
		env.headings.push({
			level,
			id: `sec-${env.headings.length + 1}`,
			text: headingText,
		});
		tok.attrSet("id", `sec-${env.headings.length}`);
	}
	return defaultHeadingOpen(tokens, idx, options, env, self);
};

// Rewrite internal links (`privacy.md`, `./example-usage.md#setup`) to their
// public routes (`/legal/privacy`, `/blogs/example-usage#setup`). Links are
// resolved relative to the current document's directory within its mount.
const defaultLinkOpen =
	md.renderer.rules.link_open ||
	((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const href = token.attrGet("href") || "";
	if (/\.md(?:#|$)/i.test(href)) {
		const clean = href.replace(/\.md(?=#|$)/i, "");
		const [linkPath, hash] = clean.split("#");
		const resolved = path.posix.normalize(path.posix.join(env.docDir, linkPath));
		const publicPath =
			env.route + (resolved === "." || resolved === "" ? "" : "/" + resolved);
		token.attrSet("href", publicPath + (hash ? "#" + hash : ""));
	}
	return defaultLinkOpen(tokens, idx, options, env, self);
};

// ---- routing helpers ----------------------------------------------------------
const SAFE_SEG = (seg) => seg.length > 0 && seg !== "." && seg !== ".." && !seg.includes("\\");

/** Match a request pathname against the configured Markdown mounts. */
export function matchMdRoute(pathname) {
	for (const cfg of MD_ROUTES) {
		if (pathname === cfg.route) return { cfg, subpath: "" };
		if (pathname.startsWith(cfg.route + "/")) {
			const sub = pathname.slice(cfg.route.length + 1);
			const segs = sub.split("/").map((s) => {
				try {
					return decodeURIComponent(s);
				} catch {
					return "";
				}
			});
			if (segs.every(SAFE_SEG)) return { cfg, subpath: segs.join("/") };
		}
	}
	return null;
}

/** Resolve a subpath to a Markdown file inside a mount (traversal-safe). */
function resolveDoc(cfg, subpath) {
	const dir = path.resolve(CONTENT_ROOT, cfg.dir);
	const base = path.resolve(dir);
	const candidates =
		subpath === ""
			? ["index.md"]
			: [`${subpath}.md`, path.join(subpath, "index.md")];
	for (const rel of candidates) {
		const abs = path.resolve(dir, rel);
		if (abs !== base && !abs.startsWith(base + path.sep)) continue; // ../ escape guard
		if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
	}
	return null;
}

function loadDoc(file, cfg, subpath) {
	const raw = fs.readFileSync(file, "utf8");
	const env = {
		route: cfg.route,
		docDir: path.posix.dirname(subpath) === "." ? "" : path.posix.dirname(subpath),
	};
	const html = md.render(raw, env);
	const firstH1 = raw.match(/^#\s+(.+)$/m);
	const stat = fs.statSync(file);
	return {
		title: (firstH1 && firstH1[1].trim()) || cfg.label,
		html,
		headings: env.headings || [],
		updatedAt: stat.mtime.toISOString().slice(0, 10),
	};
}

// ---- shared helpers ------------------------------------------------------------
function esc(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escMd(s) {
	return String(s)
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/[*_~#|]/g, (c) => "\\" + c)
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]");
}

// ---- dynamic Update Logs (fetched live from the GitHub commit history) --------
// The /docs/changelog page is generated at request time from the repository's
// public commit list, so a new commit is reflected immediately — no manual
// regeneration step. Results are cached briefly; if GitHub is unreachable or
// rate-limited we fall back to the static changelog.md on disk.
const CHANGELOG_REPO = "ChuTM/inhand"; // canonical repo (wallpaper-guard redirects here)
const CHANGELOG_REPO_BASE = `https://github.com/${CHANGELOG_REPO}`;
const CHANGELOG_TTL_MS = 5 * 60 * 1000;
const CHANGELOG_FETCH_TIMEOUT_MS = 6000;
const CHANGELOG_FAIL_BACKOFF_MS = 30 * 1000;

let changelogCache = null;
let changelogCacheAt = 0;
let changelogLastAttempt = 0;

function changelogMarkdown(commits) {
	const byDate = new Map();
	for (const c of commits) {
		if (!byDate.has(c.date)) byDate.set(c.date, []);
		byDate.get(c.date).push(c);
	}
	let md = `# Update Logs\n\nEvery commit message from the [InHand repository](${CHANGELOG_REPO_BASE}), newest first — fetched live from GitHub.\n\n`;
	for (const [date, items] of byDate) {
		md += `## ${date}\n\n`;
		for (const c of items) {
			md += `- [\`${c.hash}\`](${c.url}) ${escMd(c.subject)}\n`;
			for (const line of c.body) {
				md += `  - ${escMd(line)}\n`;
			}
		}
		md += "\n";
	}
	return md;
}

async function fetchChangelogMarkdown() {
	const now = Date.now();
	if (changelogCache && now - changelogCacheAt < CHANGELOG_TTL_MS) return changelogCache;
	if (now - changelogLastAttempt < CHANGELOG_FAIL_BACKOFF_MS) {
		throw new Error("changelog fetch on cooldown after a recent failure");
	}
	changelogLastAttempt = now;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), CHANGELOG_FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(
			`https://api.github.com/repos/${CHANGELOG_REPO}/commits?per_page=100`,
			{
				headers: { "User-Agent": "inhand-server", Accept: "application/vnd.github+json" },
				signal: ac.signal,
			},
		);
		if (!resp.ok) throw new Error(`GitHub API responded ${resp.status}`);
		const data = await resp.json();
		const commits = Array.isArray(data)
			? data.map((c) => {
					const full = String(c.commit?.message || "").trim() || "(no message)";
					const lines = full.split("\n");
					return {
						hash: String(c.sha || "").slice(0, 7),
						url: c.html_url || `${CHANGELOG_REPO_BASE}/commit/${c.sha}`,
						date: String(c.commit?.author?.date || "").slice(0, 10),
						subject: lines[0] || "(no message)",
						body: lines.slice(1).map((l) => l.trim()).filter(Boolean),
					};
				})
			: [];
		const md = changelogMarkdown(commits);
		changelogCache = md;
		changelogCacheAt = Date.now();
		return md;
	} finally {
		clearTimeout(timer);
	}
}

function htmlHeaders() {
	return {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Content-Security-Policy": [
			"default-src 'self'",
			"script-src 'self'",
			"style-src 'self'",
			"img-src 'self' data:",
			"connect-src 'self'",
			"frame-ancestors 'none'",
			"base-uri 'self'",
			"form-action 'self'",
		].join("; "),
	};
}

// ---- page shell (brand chrome; structure stays in this template) --------------
function pageShell(title, bodyHtml, currentRoute, withSpy) {
	const nav = MD_ROUTES.map(
		(cfg) =>
			`<a href="${cfg.route}"${cfg.route === currentRoute ? ' aria-current="page"' : ""}>${esc(cfg.label)}</a>`,
	).join("\n    ");
	return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<link rel="icon" type="image/png" href="/favicon.png">
<title>${esc(title)} — InHand</title>
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/legal.css">
</head>
<body>
<header class="legal-header">
  <a class="legal-brand" href="../">InHand <span class="legal-brand-sub">Docs</span></a>
</header>
<main class="legal-main">
${bodyHtml}
</main>
<footer class="legal-foot">Copyright &copy; 2026 AlphaBrate. All rights reserved.</footer>
${withSpy ? '<script src="/js/legal.js" defer></script>' : ""}
</body>
</html>`;
}

// ---- right-hand immersive section indicator (desktop) --------------------------
// Two-level contents list (h2 chapters + h3 sub-sections) with an active-state
// marker, a reading-progress fill and a "current section" label. Behaviour is
// added by /js/legal.js (scrollspy). The glass surface is the only "card" on
// the page — the document itself stays flat and immersive.
function sectionIndicator(headings) {
	if (!headings.length) return "";
	const stripNum = (t) => t.replace(/^\d+(?:\.\d+)*\.?\s+/, "");
	const items = headings
		.map((h, i) => {
			const num = String(i + 1);
			return `<li class="toc-item lvl-${h.level}" data-target="${esc(h.id)}">
  <a href="#${esc(h.id)}">
    <span class="toc-num">${num}</span>
    <span class="toc-label">${esc(stripNum(h.text))}</span>
  </a>
</li>`;
		})
		.join("\n    ");
	return `<aside class="sec-indicator" id="sec-indicator" aria-label="Sections">
  <div class="si-head">
    <span class="si-title">Contents</span>
    <span class="si-progress" id="si-progress">0%</span>
  </div>
  <div class="si-track"><div class="si-track-fill" id="si-track-fill"></div></div>
  <div class="si-current" id="si-current">—</div>
  <ol class="si-list">
    ${items}
  </ol>
</aside>
<div class="si-mobile-track" id="si-mobile-track" aria-hidden="true"><div id="si-mobile-fill"></div></div>`;
}

// ---- immersive document page ----------------------------------------------------
// Content is laid out directly on the page background — no card, no frame.
// Only the section indicator (a tool) and the header/footer chrome are glass.
export async function renderMarkdown(res, cfg, subpath) {
	// Dynamic Update Logs: render the live GitHub commit history instead of the
	// static file (falls back to the file when GitHub is unavailable).
	if (cfg.route === "/docs" && subpath === "changelog") {
		try {
			const markdown = await fetchChangelogMarkdown();
			const env = { route: cfg.route, docDir: "" };
			const html = md.render(markdown, env);
			const headings = env.headings || [];
			const body = `<div class="md-layout">
  <article class="md-doc">
    <p class="md-back"><a href="${cfg.route}">‹ ${esc(cfg.label)}</a></p>
    <div class="md-body">${html}</div>
    <p class="md-updated">Fetched live from ${esc(CHANGELOG_REPO_BASE)}</p>
  </article>
  ${sectionIndicator(headings)}
</div>`;
			res.writeHead(200, htmlHeaders());
			return res.end(pageShell("Update Logs", body, cfg.route, headings.length > 0));
		} catch {
			// fall through to the static changelog.md below
		}
	}
	const file = resolveDoc(cfg, subpath);
	if (!file) {
		res.writeHead(404, htmlHeaders());
		return res.end(
			pageShell(
				"Not found",
				'<div class="md-doc"><h1>Document not found</h1><p><a href="/legal">Back to the document index</a>.</p></div>',
				cfg.route,
				false,
			),
		);
	}
	const doc = loadDoc(file, cfg, subpath);
	const body = `<div class="md-layout">
  <article class="md-doc">
    ${subpath ? `<p class="md-back"><a href="${cfg.route}">‹ ${esc(cfg.label)}</a></p>` : ""}
    <div class="md-body">${doc.html}</div>
    <p class="md-updated">Last updated ${esc(doc.updatedAt)}</p>
  </article>
  ${sectionIndicator(doc.headings)}
</div>`;
	res.writeHead(200, htmlHeaders());
	res.end(pageShell(doc.title, body, cfg.route, doc.headings.length > 0));
}
