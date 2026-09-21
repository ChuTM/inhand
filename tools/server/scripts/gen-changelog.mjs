/**
 * gen-changelog.mjs — regenerate markdowns/docs/changelog.md from the full
 * commit history of the GitHub repository (this repo's local git history is a
 * mirror of github.com/ChuTM/inhand — wallpaper-guard redirects there — so
 * every commit message is read directly from source).
 * Run:  node scripts/gen-changelog.mjs
 *
 * Note: the live site serves /docs/changelog dynamically from the GitHub API
 * (see markdown.mjs). This script only produces the offline fallback file.
 *
 * Output: one section per commit date, newest first, each commit linked to its
 * GitHub commit page.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT_FILE = path.resolve(__dirname, "..", "markdowns", "docs", "changelog.md");

// Canonical repository (GitHub redirects the old wallpaper-guard name here).
const CHANGELOG_REPO = "ChuTM/inhand";
const repoBase = `https://github.com/${CHANGELOG_REPO}`;

function git(args) {
	return execSync(`git -C "${REPO_ROOT}" ${args}`, { encoding: "utf8" }).trim();
}

// ---- 1. Read every commit message (hash, date, subject), newest first -------
const log = git(`log --date=short --pretty=format:%h%x1f%ad%x1f%s`);
const commits = log
	.split("\n")
	.filter(Boolean)
	.map((line) => {
		const [hash, date, ...rest] = line.split("\x1f");
		return { hash, date, msg: rest.join("\x1f") || "(no message)" };
	});

// ---- 3. Escape Markdown special characters in raw commit messages ----------
function escMd(s) {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/[*_~#|]/g, (c) => "\\" + c)
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]");
}

// ---- 4. Group by date (newest first) ----------------------------------------
const byDate = new Map();
for (const c of commits) {
	if (!byDate.has(c.date)) byDate.set(c.date, []);
	byDate.get(c.date).push(c);
}

let md = `# Update Logs\n\nEvery commit message from the [InHand repository](${repoBase}), newest first.\n\n`;
for (const [date, items] of byDate) {
	md += `## ${date}\n\n`;
	for (const c of items) {
		md += `- [\`${c.hash}\`](${repoBase}/commit/${c.hash}) ${escMd(c.msg)}\n`;
	}
	md += "\n";
}

fs.writeFileSync(OUT_FILE, md);
console.log(`Wrote ${OUT_FILE} — ${commits.length} commit messages from ${repoBase}.`);
