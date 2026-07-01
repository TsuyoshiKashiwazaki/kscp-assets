#!/usr/bin/env node
/**
 * manifest.json 生成スクリプト。
 *
 * 指定オーナーの公開「wp-」リポジトリを巡回し、各々の最新版（GitHub Release 優先、
 * 無ければ最新タグ）・更新内容・日付・ダウンロード URL を 1 つの JSON に集約する。
 * Kashiwazaki SEO ControlPanel はこの 1 ファイルだけを取得して最新版を判定する。
 *
 * 実行: GITHUB_TOKEN=... MANIFEST_OWNER=TsuyoshiKashiwazaki node tools/generate-manifest.mjs
 */

import { writeFileSync } from 'node:fs';

const OWNER = process.env.MANIFEST_OWNER || 'TsuyoshiKashiwazaki';
const TOKEN = process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';
const OUT = 'manifest.json';

// セキュリティ更新を示唆するキーワード。ASCII は単語境界一致（'rce' が
// 'source' 等に誤マッチしないように）、多バイト（日本語）は部分一致。
const SECURITY_ASCII = [
	'security', 'vulnerability', 'vulnerabilities', 'cve', 'xss', 'csrf',
	'sql injection', 'injection', 'rce', 'critical', 'exploit',
	'sanitize', 'sanitization', 'open redirect', 'privilege',
	'unauthorized', 'disclosure', 'malicious',
];
const SECURITY_MB = [
	'脆弱性', 'セキュリティ', '緊急',
	'インジェクション', '情報漏洩', '漏えい', '漏洩',
	'オープンリダイレクト', '改ざん', 'なりすまし', '不正アクセス',
];

function headers() {
	const h = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'kscp-manifest-generator',
		'X-GitHub-Api-Version': '2022-11-28',
	};
	if (TOKEN) {
		h.Authorization = `Bearer ${TOKEN}`;
	}
	return h;
}

async function api(path) {
	const res = await fetch(`${API}${path}`, { headers: headers() });
	if (res.status === 404) {
		return null;
	}
	if (!res.ok) {
		throw new Error(`GitHub API ${path} -> HTTP ${res.status}`);
	}
	return res.json();
}

/** オーナーの全リポジトリをページネーションで取得。 */
async function listRepos() {
	const all = [];
	for (let page = 1; page <= 10; page++) {
		const data = await api(`/users/${encodeURIComponent(OWNER)}/repos?per_page=100&sort=full_name&page=${page}`);
		if (!Array.isArray(data) || data.length === 0) {
			break;
		}
		all.push(...data);
		if (data.length < 100) {
			break;
		}
	}
	return all;
}

function normalizeVersion(tag) {
	if (!tag) {
		return '';
	}
	let v = String(tag).trim().replace(/^[vV]/, '');
	// 末尾の -main / -master / -trunk を除去。
	v = v.replace(/-(main|master|trunk)$/i, '');
	return /^[0-9][0-9A-Za-z.\-]*$/.test(v) ? v : '';
}

function prettifyName(repo) {
	let n = repo.replace(/^wp-(plugin|theme)-/, '').replace(/[-_]+/g, ' ');
	return n.replace(/\b\w/g, (c) => c.toUpperCase());
}

function isSecurity(text) {
	const t = String(text || '');
	for (const k of SECURITY_ASCII) {
		const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		if (new RegExp(`\\b${esc}\\b`, 'i').test(t)) {
			return true;
		}
	}
	return SECURITY_MB.some((k) => t.includes(k));
}

/** バグ修正を示唆するか（ASCII 単語境界 + 多バイト部分一致）。 */
function isBugfix(text) {
	const t = String(text || '');
	if (/\b(fix|fixes|fixed|bug|bugfix|hotfix|patch)\b/i.test(t)) {
		return true;
	}
	return ['修正', '不具合', 'バグ'].some((k) => t.includes(k));
}

/**
 * 1 バージョンの変更ブロックを 3 タイプ（security / bug / update）に分類。
 * 1 リリースが複数タイプを含むことがある（例: セキュリティ + バグ + 機能追加）ので
 * 該当するものをすべて返す。Keep a Changelog の ### 見出しを最優先し、
 * 見出しが無い場合のみ本文キーワードで補完する。
 */
function classifyBlock(block) {
	const types = new Set();
	const headings = block.match(/^###\s+(.+)$/gim) || [];
	if (headings.length) {
		// 構造化ブロック（Keep a Changelog）は ### 見出しのみを信頼する。
		// 本文の箇条書きに「セキュリティ対策」等の機能説明が混ざっても誤検知しない。
		for (const h of headings) {
			const label = h.replace(/^###\s+/i, '').trim().toLowerCase();
			if (/security|セキュリティ|脆弱/.test(label)) {
				types.add('security');
			} else if (/fix|bug|修正|不具合/.test(label)) {
				types.add('bug');
			} else {
				// Added / Changed / Removed / Deprecated など＝機能・通常更新。
				types.add('update');
			}
		}
		return [...types];
	}
	// 見出しが無い自由記述ブロックのみ、本文キーワードで判定。
	if (isSecurity(block)) {
		types.add('security');
	}
	if (isBugfix(block)) {
		types.add('bug');
	}
	if (!types.size) {
		types.add('update');
	}
	return [...types];
}

/**
 * CHANGELOG.md（Keep a Changelog）または readme.txt（== Changelog ==）を
 * バージョン単位に分解し、各バージョンのタイプ配列を付ける。新しい順。
 */
function parseChangelog(text) {
	if (!text) {
		return [];
	}
	const lines = String(text).split(/\r?\n/);
	const versions = [];
	let cur = null;
	const flush = () => {
		if (cur) {
			cur.types = classifyBlock(cur.body);
			delete cur.body;
			versions.push(cur);
		}
	};
	for (const line of lines) {
		// CHANGELOG.md: "## [1.0.6] - 2026-07-01" / "## 1.0.6"
		let m = line.match(/^##\s+\[?v?(\d+(?:\.\d+)+[0-9A-Za-z.\-]*)\]?/);
		// readme.txt: "= 1.0.6 ="
		if (!m) {
			m = line.match(/^=\s*v?(\d+(?:\.\d+)+[0-9A-Za-z.\-]*)\s*=/);
		}
		if (m) {
			flush();
			cur = { version: normalizeVersion(m[1]) || m[1], body: '' };
			continue;
		}
		if (cur) {
			cur.body += `${line}\n`;
		}
	}
	flush();
	return versions.slice(0, 30);
}

/** リポジトリ内のテキストファイルを取得（無ければ空文字）。 */
async function fetchFileText(name, path) {
	const data = await api(`/repos/${OWNER}/${encodeURIComponent(name)}/contents/${encodeURIComponent(path)}`);
	if (!data || Array.isArray(data) || !data.content) {
		return '';
	}
	try {
		return Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
	} catch {
		return '';
	}
}

/**
 * セキュリティ判定・changelog 補完用にドキュメントを収集。
 * Release ノートが無い（タグ運用）リポジトリでも CHANGELOG / README /
 * readme.txt を読むことで、セキュリティ修正を取りこぼさない。
 */
async function gatherDocs(name) {
	const changelog = (await fetchFileText(name, 'CHANGELOG.md')) || (await fetchFileText(name, 'CHANGELOG'));
	const readmeMd = await fetchFileText(name, 'README.md');
	const readmeTxt = await fetchFileText(name, 'readme.txt');
	return {
		changelog,
		all: [changelog, readmeMd, readmeTxt].filter(Boolean).join('\n'),
	};
}

/** 1 リポジトリの最新版情報を取得。 */
async function latestFor(repo) {
	const name = repo.name;
	const docs = await gatherDocs(name);
	let info = null;

	// 1) GitHub Release（最新）。
	const rel = await api(`/repos/${OWNER}/${name}/releases/latest`);
	if (rel && rel.tag_name) {
		const version = normalizeVersion(rel.tag_name);
		if (version) {
			info = {
				version,
				changelog: rel.body || '',
				last_updated: rel.published_at || rel.created_at || '',
				download_url: rel.zipball_url
					|| `https://github.com/${OWNER}/${name}/archive/refs/tags/${encodeURIComponent(rel.tag_name)}.zip`,
				relBody: rel.body || '',
			};
		}
	}
	// 2) Release が無ければ最新タグ。
	if (!info) {
		const tags = await api(`/repos/${OWNER}/${name}/tags?per_page=100`);
		if (Array.isArray(tags) && tags.length > 0) {
			// 最も新しいバージョンを選ぶ（semver 風の単純比較）。
			let best = null;
			for (const t of tags) {
				const v = normalizeVersion(t.name);
				if (!v) {
					continue;
				}
				if (!best || compareVersions(v, best.version) > 0) {
					best = { version: v, tag: t.name };
				}
			}
			if (best) {
				info = {
					version: best.version,
					changelog: '',
					last_updated: repo.pushed_at || '',
					download_url: `https://github.com/${OWNER}/${name}/archive/refs/tags/${encodeURIComponent(best.tag)}.zip`,
					relBody: '',
				};
			}
		}
	}
	// 3) どちらも無ければ収録しない（バージョン不明）。
	if (!info) {
		return null;
	}

	// バージョン別タイプ一覧（新しい順）。CHANGELOG 優先、無ければ Release ノート。
	info.versions = parseChangelog(docs.changelog || info.relBody);
	// 後方互換: is_security は最新バージョンにセキュリティが含まれるか。
	info.is_security = !!(info.versions[0] && info.versions[0].types.includes('security'));
	// changelog が空（タグ運用）なら CHANGELOG 本文で補完。
	if (!info.changelog && docs.changelog) {
		info.changelog = docs.changelog;
	}
	return info;
}

/** バージョンを数値コアとプレリリース部に分解。 */
function splitVersion(v) {
	const m = String(v).match(/^(\d+(?:\.\d+)*)(?:[-.](.+))?$/);
	if (!m) {
		return { nums: [0], pre: '' };
	}
	return { nums: m[1].split('.').map((n) => parseInt(n, 10)), pre: m[2] || '' };
}

/** semver 風比較。数値コア優先、同値なら「プレリリース無し > 有り」。 */
function compareVersions(a, b) {
	const A = splitVersion(a);
	const B = splitVersion(b);
	const len = Math.max(A.nums.length, B.nums.length);
	for (let i = 0; i < len; i++) {
		const x = A.nums[i] || 0;
		const y = B.nums[i] || 0;
		if (x !== y) {
			return x - y;
		}
	}
	if (A.pre === B.pre) {
		return 0;
	}
	if (A.pre === '') {
		return 1; // a は正式版 → 上位
	}
	if (B.pre === '') {
		return -1; // b は正式版 → 上位
	}
	return A.pre < B.pre ? -1 : 1;
}

async function main() {
	const repos = await listRepos();
	const wp = repos.filter((r) => /^wp-/i.test(r.name) && !r.archived && !r.disabled);
	const items = [];

	for (const repo of wp) {
		try {
			const latest = await latestFor(repo);
			if (!latest) {
				continue; // バージョン判定不能なリポジトリは収録しない。
			}
			const type = /^wp-theme-/i.test(repo.name) ? 'theme' : 'plugin';
			items.push({
				slug: repo.name,
				repo: repo.name,
				type,
				name: prettifyName(repo.name),
				latest_version: latest.version,
				last_updated: latest.last_updated,
				changelog: (latest.changelog || '').slice(0, 4000),
				is_security: latest.is_security,
				versions: latest.versions || [],
				html_url: repo.html_url,
				download_url: latest.download_url,
			});
		} catch (e) {
			console.error(`skip ${repo.name}: ${e.message}`);
		}
	}

	items.sort((a, b) => a.slug.localeCompare(b.slug));

	const manifest = {
		schema: 1,
		generated_at: new Date().toISOString(),
		owner: OWNER,
		items,
	};

	writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
	console.log(`Wrote ${OUT} with ${items.length} items.`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
