#!/usr/bin/env node
/**
 * GitHub Repos — NarraFork plugin server.
 *
 * Transport: newline-delimited JSON-RPC over stdio (narrafork.rpc/1).
 * Host -> plugin: tools.invoke { contributionId, input, context }
 * Plugin -> host: secrets.get / config.get / diagnostics.getOwn ...
 *
 * stdout is reserved for protocol frames; all logging goes to stderr.
 */

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API_BASE = (process.env.NF_GITHUB_API_BASE ?? "").trim().replace(/\/+$/, "") || "https://api.github.com";
/**
 * Version reported to GitHub and to the host.
 *
 * Derived from manifest.json so the two cannot drift: a hardcoded copy here ships a
 * User-Agent naming the previous release as soon as the manifest is bumped.
 */
const PLUGIN_VERSION_FALLBACK = "0.4.1";
let cachedVersion = null;
function pluginVersion() {
	if (cachedVersion === null) {
		cachedVersion = readPluginManifest()?.version ?? PLUGIN_VERSION_FALLBACK;
	}
	return cachedVersion;
}
function userAgent() {
	return `narrafork-github-repos-plugin/${pluginVersion()}`;
}
const SECRET_ID = "github_token";
/** Every managed token is stored under `github_token` or `github_token__<slug>`. */
const SECRET_PREFIX = "github_token";
/** Plugin storage key holding the label of the token the tools should use. */
const ACTIVE_KEY = "activeSecretKey";
/**
 * Every `storage.*` host call MUST carry an explicit scope.
 *
 * Both the backend dispatcher and the UI bridge reject a scope-less call
 * (`Storage scope is required` / `Invalid storage scope`), which is why the earlier
 * `{ key }`-only calls silently fell back to the default token. `global` is the only
 * scope type the two sides agree on without knowing a runtime/workspace id — and
 * "which token is active" is plugin-wide state, so global is also the honest choice.
 */
const STORAGE_SCOPE = { type: "global" };
const HOST_CALL_TIMEOUT_MS = 3000;
const PLUGIN_ID = "com.yh100200com.github-repos";
const RPC_PROTOCOL = "narrafork.rpc/1";
const PLUGIN_FEATURES = ["host_api.requests"];

function readPluginManifest() {
	try {
		const packageDir = process.env.NF_PLUGIN_PACKAGE_DIR;
		const manifestPath = packageDir
			? join(packageDir, "manifest.json")
			: join(dirname(dirname(fileURLToPath(import.meta.url))), "manifest.json");
		return JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		log(`manifest read failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

let nextId = 1;
const pending = new Map();
let tokenPromise = null;

function log(...args) {
	const line = `[github-repos] ${args.map(String).join(" ")}\n`;
	process.stderr.write(line);
	// The host does not always capture stderr, so also tee into the plugin log dir
	// (NF_PLUGIN_LOG_DIR) to keep startup diagnostics readable.
	try {
		const dir = process.env.NF_PLUGIN_LOG_DIR;
		if (dir) appendFileSync(join(dir, "github-repos.log"), `${new Date().toISOString()} ${line}`);
	} catch {
		/* logging must never break the protocol */
	}
}

function writeMessage(message) {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

/**
 * Call a host API method.
 *
 * Resolves `null` when the host does not answer, but never silently: a timeout and an
 * error response are both logged with the method name. Collapsing every failure into a
 * bare `null` is what made an earlier `storage.*` scope rejection look like "no token
 * selected yet" — the caller could not tell a real absence from a broken call.
 */
function hostCall(method, params, timeoutMs = HOST_CALL_TIMEOUT_MS) {
	const id = `plugin-${nextId++}`;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			log(`host call ${method} timed out after ${timeoutMs}ms`);
			resolve(null);
		}, timeoutMs);
		pending.set(id, (outcome) => {
			clearTimeout(timer);
			if (outcome && outcome.error) {
				log(`host call ${method} failed: ${outcome.error.code ?? "?"} ${outcome.error.message ?? ""}`);
			}
			resolve(outcome ? outcome.result ?? null : null);
		});
		writeMessage({ jsonrpc: "2.0", id, method, params });
	});
}

/** Pull a plausible secret value out of whatever shape the host returns. */
function extractValue(result) {
	if (result == null) return null;
	if (typeof result === "string") return result.trim() || null;
	const seen = new Set();
	const stack = [result];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node == null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		for (const [key, value] of Object.entries(node)) {
			if (typeof value === "string" && value.trim() !== "" && /^(value|secret|token|plaintext|text|data)$/i.test(key)) {
				return value.trim();
			}
			if (value && typeof value === "object") stack.push(value);
		}
	}
	return null;
}

/**
 * Which secret key to read. The config UI keeps several tokens and records the chosen
 * one in plugin storage (`activeSecretKey`); without that it falls back to the default.
 *
 * Note the host contracts: `secrets.*` take exactly `{ key }`, `storage.*` take
 * `{ scope, key }` (scope is mandatory, see STORAGE_SCOPE), and `config.get` /
 * `secrets.list` take NO parameters (strict `{}`).
 */
async function resolveActiveKey() {
	try {
		const stored = await hostCall("storage.get", { scope: STORAGE_SCOPE, key: ACTIVE_KEY });
		const value = stored && typeof stored === "object" ? stored.value : stored;
		if (typeof value === "string" && value.startsWith(SECRET_PREFIX)) return value;
	} catch {
		/* storage unavailable: fall through to the default key */
	}
	return SECRET_ID;
}

async function resolveToken() {
	if (tokenPromise) return tokenPromise;
	tokenPromise = (async () => {
		const activeKey = await resolveActiveKey();
		const candidates = activeKey === SECRET_ID ? [SECRET_ID] : [activeKey, SECRET_ID];
		for (const key of candidates) {
			try {
				const result = await hostCall("secrets.get", { key });
				const value = result && typeof result === "object" ? result.value : result;
				if (typeof value === "string" && value.trim() !== "") {
					log(`token resolved from secret ${key}`);
					return value.trim();
				}
			} catch (error) {
				log(`secrets.get ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// The active-token marker can be absent (it is written by the config panel, and a
		// failed marker write leaves the saved tokens unreachable). Rather than silently
		// falling back to anonymous access — which looks like "the token is wrong" — fall
		// back to whatever token is actually saved.
		for (const key of await listTokenKeys()) {
			if (candidates.includes(key)) continue;
			try {
				const result = await hostCall("secrets.get", { key });
				const value = result && typeof result === "object" ? result.value : result;
				if (typeof value === "string" && value.trim() !== "") {
					log(`token resolved from saved secret ${key} (no active marker set)`);
					return value.trim();
				}
			} catch (error) {
				log(`secrets.get ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
			const value = process.env[name];
			if (typeof value === "string" && value.trim() !== "") {
				log(`token resolved from ${name}`);
				return value.trim();
			}
		}
		log("no GitHub token configured; using anonymous access");
		return null;
	})();
	return tokenPromise;
}

/** Drop the cached token so the next call re-reads after the user switches tokens. */
function invalidateToken() {
	tokenPromise = null;
}

/** All managed token keys, newest naming scheme first. */
async function listTokenKeys() {
	const result = await hostCall("secrets.list", {});
	const entries = Array.isArray(result?.secrets) ? result.secrets : [];
	return entries
		.map((entry) => (typeof entry === "string" ? entry : entry?.key))
		.filter((key) => typeof key === "string" && key.startsWith(SECRET_PREFIX));
}

class ToolError extends Error {}

async function githubFetch(path, { method = "GET", body, accept } = {}) {
	const token = await resolveToken();
	const headers = {
		Accept: accept ?? "application/vnd.github+json",
		"User-Agent": userAgent(),
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";

	let response;
	try {
		response = await fetch(`${API_BASE}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (error) {
		throw new ToolError(`请求 GitHub 失败：${error instanceof Error ? error.message : String(error)}`);
	}

	const text = await response.text();
	let payload = null;
	if (text.length > 0) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = text;
		}
	}

	if (!response.ok) {
		const detail = payload && typeof payload === "object" && typeof payload.message === "string" ? payload.message : typeof payload === "string" ? payload.slice(0, 300) : response.statusText;
		const hint = response.status === 401 ? "（token 无效或缺失）" : response.status === 403 ? "（权限不足或触发限流）" : "";
		throw new ToolError(`GitHub API ${response.status} ${detail}${hint}`);
	}
	return payload;
}

function requireString(input, key) {
	const value = input[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new ToolError(`参数 ${key} 必须是非空字符串`);
	}
	return value.trim();
}

function optionalInt(input, key, fallback, min, max) {
	const raw = input[key];
	if (raw === undefined || raw === null) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new ToolError(`参数 ${key} 必须是数字`);
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function truncate(text, limit) {
	if (typeof text !== "string") return text;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n…（已截断，原始长度 ${text.length} 字符）`;
}

const tools = {
	async github_list_repos(input) {
		const owner = typeof input.owner === "string" ? input.owner.trim() : "";
		const visibility = input.visibility ?? "all";
		const sort = input.sort ?? "updated";
		const limit = optionalInt(input, "limit", 20, 1, 100);

		const params = new URLSearchParams({ per_page: String(limit), sort });
		const path = owner ? `/users/${encodeURIComponent(owner)}/repos` : `/user/repos`;
		if (owner && visibility !== "all") params.set("type", visibility);
		if (!owner && visibility !== "all") params.set("visibility", visibility);

		const repos = await githubFetch(`${path}?${params.toString()}`);
		if (!Array.isArray(repos)) throw new ToolError("GitHub 返回了非预期的响应结构");
		return {
			count: repos.length,
			repositories: repos.map((repo) => ({
				full_name: repo.full_name,
				private: Boolean(repo.private),
				description: repo.description ?? null,
				default_branch: repo.default_branch ?? null,
				language: repo.language ?? null,
				stars: repo.stargazers_count ?? 0,
				open_issues: repo.open_issues_count ?? 0,
				updated_at: repo.updated_at ?? null,
				html_url: repo.html_url ?? null,
			})),
		};
	},

	async github_get_file(input) {
		const owner = requireString(input, "owner");
		const repo = requireString(input, "repo");
		const path = requireString(input, "path");
		const maxBytes = optionalInt(input, "maxBytes", 262144, 1024, 1048576);
		const ref = typeof input.ref === "string" && input.ref.trim() !== "" ? input.ref.trim() : undefined;

		const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
		const file = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}${query}`);
		if (Array.isArray(file)) throw new ToolError("该路径是目录，请改用 github_list_dir");
		if (!file || typeof file !== "object") throw new ToolError("GitHub 返回了非预期的响应结构");

		let content = "";
		let encoding = file.encoding ?? "base64";
		if (typeof file.content === "string" && file.content.length > 0) {
			content = encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
		} else if (file.size > 0) {
			throw new ToolError("文件过大，GitHub 未内联返回内容，请改用 raw 下载或分段读取");
		}

		const truncated = Buffer.byteLength(content, "utf8") > maxBytes;
		return {
			path: file.path ?? path,
			sha: file.sha ?? null,
			size: file.size ?? Buffer.byteLength(content, "utf8"),
			truncated,
			content: truncate(content, maxBytes),
		};
	},

	async github_list_dir(input) {
		const owner = requireString(input, "owner");
		const repo = requireString(input, "repo");
		const path = typeof input.path === "string" ? input.path.trim().replace(/^\/+|\/+$/g, "") : "";
		const ref = typeof input.ref === "string" && input.ref.trim() !== "" ? input.ref.trim() : undefined;

		const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
		const encodedPath = path === "" ? "" : `/${path.split("/").map(encodeURIComponent).join("/")}`;
		const listing = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${encodedPath}${query}`);
		if (!Array.isArray(listing)) throw new ToolError("该路径不是目录，请改用 github_get_file");
		return {
			path: path === "" ? "/" : path,
			count: listing.length,
			entries: listing.map((entry) => ({
				name: entry.name,
				type: entry.type,
				size: entry.size ?? 0,
				sha: entry.sha ?? null,
			})),
		};
	},

	async github_search_code(input) {
		const query = requireString(input, "query");
		const limit = optionalInt(input, "limit", 10, 1, 50);
		const token = await resolveToken();
		if (!token) throw new ToolError("代码搜索需要 GitHub token，请先在插件设置里填入 github_token");

		const result = await githubFetch(`/search/code?q=${encodeURIComponent(query)}&per_page=${limit}`);
		const items = Array.isArray(result?.items) ? result.items : [];
		return {
			total_count: result?.total_count ?? items.length,
			items: items.map((item) => ({
				repository: item.repository?.full_name ?? null,
				path: item.path ?? null,
				name: item.name ?? null,
				html_url: item.html_url ?? null,
			})),
		};
	},

	async github_list_issues(input) {
		const owner = requireString(input, "owner");
		const repo = requireString(input, "repo");
		const state = input.state ?? "open";
		const limit = optionalInt(input, "limit", 20, 1, 100);
		const includePullRequests = input.includePullRequests === true;

		const params = new URLSearchParams({ state, per_page: String(includePullRequests ? limit : Math.min(100, limit * 2)) });
		const issues = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`);
		if (!Array.isArray(issues)) throw new ToolError("GitHub 返回了非预期的响应结构");

		const filtered = includePullRequests ? issues : issues.filter((issue) => !issue.pull_request);
		return {
			state,
			count: Math.min(filtered.length, limit),
			issues: filtered.slice(0, limit).map((issue) => ({
				number: issue.number,
				title: issue.title,
				state: issue.state,
				is_pull_request: Boolean(issue.pull_request),
				user: issue.user?.login ?? null,
				labels: Array.isArray(issue.labels) ? issue.labels.map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean) : [],
				comments: issue.comments ?? 0,
				updated_at: issue.updated_at ?? null,
				html_url: issue.html_url ?? null,
			})),
		};
	},

	/** List every saved token (labels only — secret values are never echoed). */
	async github_token_list() {
		const keys = await listTokenKeys();
		let active = SECRET_ID;
		try {
			const stored = await hostCall("storage.get", { scope: STORAGE_SCOPE, key: ACTIVE_KEY });
			const value = stored && typeof stored === "object" ? stored.value : stored;
			if (typeof value === "string" && value.startsWith(SECRET_PREFIX)) active = value;
		} catch {
			/* keep default */
		}
		return {
			active,
			tokens: keys.map((key) => ({
				key,
				label: key === SECRET_ID ? "默认" : key.slice(SECRET_PREFIX.length + 2),
				active: key === active,
			})),
		};
	},

	/** Save a token under a label, optionally making it the active one. */
	async github_token_add(input) {
		const token = requireString(input, "token");
		if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]+$/.test(token) && token.length < 20) {
			throw new ToolError("这不像一个 GitHub token（通常以 ghp_ / github_pat_ 开头）");
		}
		const rawLabel = typeof input.label === "string" ? input.label.trim() : "";
		const slug = rawLabel.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
		const key = slug === "" ? SECRET_ID : `${SECRET_PREFIX}__${slug}`;

		await hostCall("secrets.set", { key, value: token });
		const makeActive = input.makeActive !== false;
		if (makeActive) await hostCall("storage.set", { scope: STORAGE_SCOPE, key: ACTIVE_KEY, value: key });
		invalidateToken();
		log(`token saved as ${key}${makeActive ? " (active)" : ""}`);

		return {
			key,
			label: slug === "" ? "默认" : slug,
			active: makeActive,
			note: makeActive ? "已设为当前使用的 token" : "已保存，未切换",
		};
	},

	/** Switch which saved token the tools use. */
	async github_token_use(input) {
		const target = requireString(input, "label");
		const keys = await listTokenKeys();
		const key =
			keys.find((candidate) => candidate === target) ??
			keys.find((candidate) => candidate === `${SECRET_PREFIX}__${target}`) ??
			keys.find((candidate) => candidate === SECRET_PREFIX && target === "默认");
		if (!key) {
			throw new ToolError(`没有找到 token「${target}」。现有：${keys.join(", ") || "（空）"}`);
		}
		await hostCall("storage.set", { scope: STORAGE_SCOPE, key: ACTIVE_KEY, value: key });
		invalidateToken();
		return { active: key, note: "已切换" };
	},

	/** Delete a saved token by label. */
	async github_token_remove(input) {
		const target = requireString(input, "label");
		const keys = await listTokenKeys();
		const key =
			keys.find((candidate) => candidate === target) ??
			keys.find((candidate) => candidate === `${SECRET_PREFIX}__${target}`) ??
			keys.find((candidate) => candidate === SECRET_PREFIX && target === "默认");
		if (!key) {
			throw new ToolError(`没有找到 token「${target}」。现有：${keys.join(", ") || "（空）"}`);
		}
		await hostCall("secrets.delete", { key });
		const remaining = keys.filter((candidate) => candidate !== key);
		await hostCall("storage.set", { scope: STORAGE_SCOPE, key: ACTIVE_KEY, value: remaining[0] ?? SECRET_ID });
		invalidateToken();
		return { removed: key, active: remaining[0] ?? SECRET_ID };
	},

	async github_issue_detail(input) {		const owner = requireString(input, "owner");
		const repo = requireString(input, "repo");
		const number = optionalInt(input, "number", NaN, 1, Number.MAX_SAFE_INTEGER);
		if (!Number.isFinite(number)) throw new ToolError("参数 number 必须是正整数");
		const maxBodyChars = optionalInt(input, "maxBodyChars", 8000, 256, 65536);

		const issue = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`);
		if (!issue || typeof issue !== "object") throw new ToolError("GitHub 返回了非预期的响应结构");
		return {
			number: issue.number,
			title: issue.title,
			state: issue.state,
			is_pull_request: Boolean(issue.pull_request),
			user: issue.user?.login ?? null,
			labels: Array.isArray(issue.labels) ? issue.labels.map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean) : [],
			comments: issue.comments ?? 0,
			created_at: issue.created_at ?? null,
			updated_at: issue.updated_at ?? null,
			html_url: issue.html_url ?? null,
			body: truncate(issue.body ?? "", maxBodyChars),
		};
	},

	async github_create_issue_comment(input) {
		const owner = requireString(input, "owner");
		const repo = requireString(input, "repo");
		const number = optionalInt(input, "number", NaN, 1, Number.MAX_SAFE_INTEGER);
		if (!Number.isFinite(number)) throw new ToolError("参数 number 必须是正整数");
		const body = requireString(input, "body");

		const token = await resolveToken();
		if (!token) throw new ToolError("发表评论需要 GitHub token，请先在插件设置里填入 github_token");

		const comment = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, {
			method: "POST",
			body: { body },
		});
		return {
			id: comment?.id ?? null,
			html_url: comment?.html_url ?? null,
			created_at: comment?.created_at ?? null,
		};
	},
};

function toolIdFrom(params) {
	const raw = params?.contributionId ?? params?.toolId ?? params?.id ?? "";
	const text = typeof raw === "string" ? raw : "";
	const trimmed = text.split(/[/:]/).filter(Boolean).pop() ?? "";
	return trimmed;
}

/**
 * Plugin commands the config panel can invoke directly.
 *
 * `commands.invoke` reaches this process through the same Host→Plugin channel as
 * `tools.invoke`, so a panel button can run backend logic the iframe cannot: the panel
 * never sees the token, only the verdict. Declared in `contributes.commands` with
 * `handler: "server"`.
 */
const commands = {
	/**
	 * Check whether a saved token actually authenticates, and against which account.
	 *
	 * Exists because a bad token and a missing token are indistinguishable from the
	 * panel: both make every tool fail with 401, and the panel cannot read the secret to
	 * tell them apart. This reports the GitHub identity instead, so "which account is
	 * this label?" is answerable without ever printing the credential.
	 */
	async "verify-token"(input) {
		const requested =
			typeof input?.key === "string" && input.key.trim() !== "" ? input.key.trim() : null;
		const key = requested ?? (await resolveActiveKey());
		const result = await hostCall("secrets.get", { key });
		const value = result && typeof result === "object" ? result.value : result;
		if (typeof value !== "string" || value.trim() === "") {
			return {
				key,
				label: labelForKey(key),
				ok: false,
				reason: "empty",
				message: `「${labelForKey(key)}」没有保存 token 内容。`,
			};
		}

		const token = value.trim();
		let response;
		try {
			response = await fetch(`${API_BASE}/user`, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"User-Agent": userAgent(),
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});
		} catch (error) {
			return {
				key,
				label: labelForKey(key),
				ok: false,
				reason: "network",
				message: `无法连接 GitHub：${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const scopes = response.headers.get("x-oauth-scopes");
		if (!response.ok) {
			return {
				key,
				label: labelForKey(key),
				ok: false,
				reason: response.status === 401 ? "invalid" : "error",
				status: response.status,
				message:
					response.status === 401
						? "token 无效或已被撤销。"
						: `GitHub 返回 ${response.status}。`,
			};
		}

		const user = await response.json().catch(() => null);
		const rateLimit = response.headers.get("x-ratelimit-limit");
		const rateRemaining = response.headers.get("x-ratelimit-remaining");
		return {
			key,
			label: labelForKey(key),
			ok: true,
			login: typeof user?.login === "string" ? user.login : null,
			name: typeof user?.name === "string" ? user.name : null,
			html_url: typeof user?.html_url === "string" ? user.html_url : null,
			// Fine-grained tokens report an empty scope header; say "fine-grained" rather
			// than showing an empty list, which reads like "no permissions".
			scopes: scopes && scopes.trim() !== "" ? scopes.split(",").map((item) => item.trim()).filter(Boolean) : null,
			rate_limit: rateLimit ? { limit: Number(rateLimit), remaining: Number(rateRemaining) } : null,
		};
	},
};

/** Display label for a secret key; the inverse of the slug used when saving. */
function labelForKey(key) {
	return key === SECRET_ID ? "默认" : key.slice(SECRET_PREFIX.length + 2);
}

function respond(id, result) {
	writeMessage({ jsonrpc: "2.0", id, result });
}

/**
 * The host validates every tool result against a strict shape: either a plain string or
 * `{ output: string, isError?, title?, metadata? }`. An MCP-style `{ content: [...] }`
 * envelope is rejected outright with PROTOCOL_ERROR, so the payload is serialized here
 * and handed over as `output`.
 */
function stringifyPayload(payload) {
	if (typeof payload === "string") return payload;
	try {
		return JSON.stringify(payload, null, 2);
	} catch (error) {
		// A payload that cannot be serialized must not turn a successful call into a
		// protocol fault; say so in-band instead.
		return `调用成功，但结果无法序列化为 JSON：${error instanceof Error ? error.message : String(error)}`;
	}
}

function respondError(id, code, message) {
	writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(message) {
	const { id, method, params } = message;
	if (method === "tools.invoke") {
		const toolId = toolIdFrom(params);
		const handler = Object.prototype.hasOwnProperty.call(tools, toolId) ? tools[toolId] : null;
		if (!handler) {
			respondError(id, -32602, `Unknown tool contribution: ${toolId || "(empty)"}`);
			return;
		}
		const input = params?.input && typeof params.input === "object" ? params.input : {};
		try {
			const payload = await handler(input);
			respond(id, { output: stringifyPayload(payload) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(`tool ${toolId} failed: ${message}`);
			respond(id, { output: `调用失败：${message}`, isError: true });
		}
		return;
	}

	// `commands.invoke` carries the same `contributionId` / `input` envelope as tools, but
	// its result contract is different: the host validates `{ output?, secretWrites?,
	// configWrites? }` and never wraps it in a tool-result envelope, so the payload is
	// returned as-is (an object the panel can read) rather than stringified.
	if (method === "commands.invoke") {
		const commandId = toolIdFrom(params);
		const handler = Object.prototype.hasOwnProperty.call(commands, commandId)
			? commands[commandId]
			: null;
		if (!handler) {
			respondError(id, -32602, `Unknown command contribution: ${commandId || "(empty)"}`);
			return;
		}
		const input = params?.input && typeof params.input === "object" ? params.input : {};
		try {
			respond(id, { output: await handler(input) });
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			log(`command ${commandId} failed: ${text}`);
			respondError(id, -32000, `命令执行失败：${text}`);
		}
		return;
	}

	if (method === "initialize" || method === "activate" || method === "health" || method === "ping") {
		const ack = { initialize: "initialized", activate: "activated", health: "healthy" }[method];
		respond(id, { ok: true, protocol: "narrafork.rpc/1", plugin: "com.yh100200com.github-repos" });
		// The host waits for the matching control notification after each control request.
		if (ack) writeMessage({ jsonrpc: "2.0", method: ack });
		return;
	}

	if (method === "shutdown") {
		respond(id, { ok: true });
		setTimeout(() => process.exit(0), 10);
		return;
	}

	// Notifications (no id) are ignored; unknown requests get METHOD_NOT_FOUND.
	if (id === undefined) return;
	respondError(id, -32601, `Method not found: ${method}`);
}

function handleMessage(message) {
	if (message == null || typeof message !== "object") return;

	// Host reply to one of our outbound calls.
	if (typeof message.method !== "string") {
		const resolver = pending.get(message.id);
		if (resolver) {
			pending.delete(message.id);
			// Hand the whole envelope over so hostCall can log the error, not just the result.
			resolver({ result: message.result, error: message.error });
		}
		return;
	}

	if (message.method.startsWith("$/")) return;
	handleRequest(message).catch((error) => {
		log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
		if (message.id !== undefined) respondError(message.id, -32603, "Internal plugin error");
	});
}

let frameBuffer = Buffer.alloc(0);

function readContentLength(headerBlock) {
	for (const line of headerBlock.split("\r\n")) {
		const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
		if (match) return Number(match[1]);
	}
	return null;
}

function drainFrames() {
	for (;;) {
		const separator = frameBuffer.indexOf("\r\n\r\n");
		if (separator < 0) {
			// Tolerate bare-LF header blocks too.
			const lf = frameBuffer.indexOf("\n\n");
			if (lf < 0) return;
			const headerBlock = frameBuffer.subarray(0, lf).toString("utf8");
			const length = readContentLength(headerBlock);
			if (length === null) {
				log("dropping frame without Content-Length");
				frameBuffer = frameBuffer.subarray(lf + 2);
				continue;
			}
			if (frameBuffer.length < lf + 2 + length) return;
			const body = frameBuffer.subarray(lf + 2, lf + 2 + length).toString("utf8");
			frameBuffer = frameBuffer.subarray(lf + 2 + length);
			deliverFrame(body);
			continue;
		}

		const headerBlock = frameBuffer.subarray(0, separator).toString("utf8");
		const length = readContentLength(headerBlock);
		if (length === null) {
			log("dropping frame without Content-Length");
			frameBuffer = frameBuffer.subarray(separator + 4);
			continue;
		}
		if (frameBuffer.length < separator + 4 + length) return;
		const body = frameBuffer.subarray(separator + 4, separator + 4 + length).toString("utf8");
		frameBuffer = frameBuffer.subarray(separator + 4 + length);
		deliverFrame(body);
	}
}

function deliverFrame(body) {
	const trimmed = body.trim();
	if (trimmed === "") return;
	try {
		handleMessage(JSON.parse(trimmed));
	} catch (error) {
		log(`bad frame: ${error instanceof Error ? error.message : String(error)}`);
	}
}

process.stdin.on("data", (chunk) => {
	frameBuffer = frameBuffer.length === 0 ? chunk : Buffer.concat([frameBuffer, chunk]);
	drainFrames();
});

process.stdin.on("end", () => {
	// Let in-flight host calls and pending responses flush before exiting.
	setTimeout(() => process.exit(0), 500);
});
process.on("uncaughtException", (error) => log(`uncaught: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
process.on("unhandledRejection", (error) => log(`unhandled rejection: ${error instanceof Error ? error.message : String(error)}`));

log("server started (narrafork.rpc/1 over stdio)");
log(
	`boot env: node=${process.version} cwd=${process.cwd()} packageDir=${process.env.NF_PLUGIN_PACKAGE_DIR ?? "-"} logDir=${process.env.NF_PLUGIN_LOG_DIR ?? "-"} digest=${process.env.NF_PLUGIN_PACKAGE_DIGEST ?? "-"}`,
);

// The host waits for a hello frame from the plugin before it spawns further
// control traffic (initialize -> activate -> health).
const manifest = readPluginManifest();
const helloParams = {
	pluginId: PLUGIN_ID,
	version: pluginVersion(),
	rpcProtocol: RPC_PROTOCOL,
	features: Array.isArray(manifest?.engine?.features) ? manifest.engine.features : PLUGIN_FEATURES,
	sdk: { name: "narrafork-github-repos", version: pluginVersion() },
	platform: {
		os: process.platform,
		arch: process.arch,
		runtime: "node",
		runtimeVersion: process.version,
	},
};
if (process.env.NF_PLUGIN_PACKAGE_DIGEST) helloParams.packageDigest = process.env.NF_PLUGIN_PACKAGE_DIGEST;

hostCall("hello", helloParams, 10000).then((reply) => {
	if (reply) {
		log(`hello accepted: runtimeId=${reply.runtimeId ?? "?"} generation=${reply.generation ?? "?"} features=${(reply.features ?? []).join("|") || "none"}`);
	} else {
		log("hello sent but no reply received");
	}
});
