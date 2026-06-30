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
	'sql injection', 'rce', 'critical', 'exploit',
];
const SECURITY_MB = ['脆弱性', 'セキュリティ', '緊急'];

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

/** 1 リポジトリの最新版情報を取得。 */
async function latestFor(repo) {
	const name = repo.name;
	// 1) GitHub Release（最新）。
	const rel = await api(`/repos/${OWNER}/${name}/releases/latest`);
	if (rel && rel.tag_name) {
		const version = normalizeVersion(rel.tag_name);
		if (version) {
			return {
				version,
				changelog: rel.body || '',
				last_updated: rel.published_at || rel.created_at || '',
				download_url: rel.zipball_url
					|| `https://github.com/${OWNER}/${name}/archive/refs/tags/${encodeURIComponent(rel.tag_name)}.zip`,
				is_security: isSecurity(rel.body),
			};
		}
	}
	// 2) Release が無ければ最新タグ。
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
			return {
				version: best.version,
				changelog: '',
				last_updated: repo.pushed_at || '',
				download_url: `https://github.com/${OWNER}/${name}/archive/refs/tags/${encodeURIComponent(best.tag)}.zip`,
				is_security: false,
			};
		}
	}
	// 3) どちらも無ければ既定ブランチの zip（バージョン不明）。
	return null;
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
