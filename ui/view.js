/**
 * GitHub Repos — token management view.
 *
 * Runs inside the host-controlled iframe shell. The shell installs
 * `globalThis.narrafork` after the postMessage handshake, so this file keeps
 * polling for it, then renders plain DOM (no React/Mantine runtime needed).
 *
 * Host API constraints worth remembering (they are strict zod schemas):
 *   - `secrets.get/set/delete({ key, value? })` — there is NO `id`/`secretId` alias.
 *   - `secrets.list({})` and `config.get({})` take no parameters at all.
 *   - `storage.get/set/delete/list` REQUIRE an explicit `scope`; a scope-less call fails
 *     with "Invalid storage scope" and nothing ever gets stored. See STORAGE_SCOPE.
 *   - A UI session may never read plaintext (`secrets.get` needs an admin session),
 *     so listing shows labels only, and "which token is active" lives in storage.
 */

const SECRET_PREFIX = "github_token";
const DEFAULT_KEY = "github_token";
const ACTIVE_KEY = "activeSecretKey";
/**
 * Plugin storage scope for the "which token is active" marker.
 *
 * The host rejects a scope-less `storage.*` call, and for every non-global scope type it
 * also requires `id` to equal the id bound to this UI session (workspace id for a
 * workspace panel, nothing at all for the settings-surface panel). `global` is the only
 * type that behaves identically on both surfaces, and the marker is genuinely
 * plugin-wide state, so the settings panel and the workspace panel always agree.
 */
const STORAGE_SCOPE = { type: "global" };

// Visible in-iframe diagnostics: the shell removes its splash only when this
// script finishes loading, so a marker rendered immediately tells us whether
// the entry was actually served when the panel looks stuck.
const marker = (() => {
	const node = document.createElement("div");
	node.id = "github-config-marker";
	node.style.cssText =
		"position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:6px 10px;border-radius:6px;" +
		"font:12px/1.4 system-ui,sans-serif;background:#1f2937;color:#e5e7eb;opacity:.92;pointer-events:none;" +
		"max-width:calc(100% - 16px);white-space:pre-wrap;";
	node.textContent = "入口脚本已执行，等待宿主桥…";
	const attach = () => document.body.appendChild(node);
	if (document.body) attach();
	else document.addEventListener("DOMContentLoaded", attach, { once: true });
	return node;
})();

function boot() {
	if (typeof globalThis.narrafork !== "undefined") {
		marker.remove();
		render(globalThis.narrafork);
		return;
	}
	const started = Date.now();
	const timer = setInterval(() => {
		if (typeof globalThis.narrafork !== "undefined") {
			clearInterval(timer);
			marker.remove();
			render(globalThis.narrafork);
			return;
		}
		const waited = Math.round((Date.now() - started) / 1000);
		if (waited >= 8) {
			clearInterval(timer);
			marker.textContent = `入口脚本已执行，但 8 秒内未收到宿主桥（globalThis.narrafork 未注入）。\nprotocol=${location.protocol} parent=${window.parent !== window}`;
		} else {
			marker.textContent = `入口脚本已执行，等待宿主桥… ${waited}s`;
		}
	}, 250);
}

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "style") Object.assign(node.style, value);
		else if (key === "text") node.textContent = value;
		else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
		else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
	}
	for (const child of children) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
	return node;
}

const COLORS = {
	text: "var(--nf-color-text, #e6e6e6)",
	dimmed: "var(--nf-color-dimmed, #909296)",
	border: "var(--nf-color-border, #373a40)",
	surface: "var(--nf-color-surface, #25262b)",
	primary: "var(--nf-color-primary, #4c6ef5)",
	error: "var(--nf-color-error, #fa5252)",
	success: "var(--nf-color-success, #40c057)",
	radius: "var(--nf-radius, 6px)",
	mono: "var(--nf-font-mono, ui-monospace, monospace)",
};

function buttonStyle(kind) {
	const base = {
		padding: "6px 12px",
		borderRadius: COLORS.radius,
		border: `1px solid ${COLORS.border}`,
		background: "transparent",
		color: COLORS.text,
		cursor: "pointer",
		fontSize: "13px",
		lineHeight: "1.4",
	};
	if (kind === "primary") return { ...base, background: COLORS.primary, borderColor: COLORS.primary, color: "#fff" };
	if (kind === "danger") return { ...base, color: COLORS.error, borderColor: COLORS.error };
	return base;
}

function inputStyle() {
	return {
		width: "100%",
		boxSizing: "border-box",
		padding: "8px 10px",
		borderRadius: COLORS.radius,
		border: `1px solid ${COLORS.border}`,
		background: COLORS.surface,
		color: COLORS.text,
		fontSize: "13px",
	};
}

function render(api) {
	document.body.innerHTML = "";
	document.body.style.cssText = `margin:0;padding:16px;font-family:var(--nf-font, system-ui, sans-serif);font-size:14px;color:${COLORS.text};background:var(--nf-color-body, transparent);`;

	const listHost = el("div", { style: { marginBottom: "16px" } });
	const status = el("div", {
		style: { minHeight: "18px", marginBottom: "10px", fontSize: "13px", color: COLORS.dimmed, whiteSpace: "pre-wrap" },
	});

	function setStatus(text, tone) {
		status.textContent = text;
		status.style.color = tone === "error" ? COLORS.error : tone === "success" ? COLORS.success : COLORS.dimmed;
	}

	/**
	 * Read the active-token marker.
	 *
	 * The failure is returned rather than swallowed: a rejected scope here looks exactly
	 * like "the user has not chosen a token yet", which is how a broken storage call
	 * stayed invisible while the panel kept rendering an empty selection.
	 */
	async function readActiveKey() {
		try {
			const stored = await api.storage.get({ scope: STORAGE_SCOPE, key: ACTIVE_KEY });
			const value = stored && typeof stored === "object" ? stored.value : stored;
			if (typeof value === "string" && value.startsWith(SECRET_PREFIX)) return { key: value };
			return { key: DEFAULT_KEY };
		} catch (error) {
			return { key: DEFAULT_KEY, error: error?.message ?? String(error) };
		}
	}

	async function writeActiveKey(key) {
		await api.storage.set({ scope: STORAGE_SCOPE, key: ACTIVE_KEY, value: key });
	}

	async function readKeys() {
		const result = await api.secrets.list();
		const entries = Array.isArray(result?.secrets) ? result.secrets : Array.isArray(result) ? result : [];
		return entries
			.map((entry) => (typeof entry === "string" ? entry : entry?.key))
			.filter((key) => typeof key === "string" && key.startsWith(SECRET_PREFIX));
	}

	function labelOf(key) {
		return key === DEFAULT_KEY ? "默认" : key.slice(SECRET_PREFIX.length + 2);
	}

	async function refresh() {
		listHost.replaceChildren(el("div", { style: { color: COLORS.dimmed, fontSize: "13px" }, text: "正在读取…" }));
		try {
			const [keys, activeResult] = await Promise.all([readKeys(), readActiveKey()]);
			renderList(keys, activeResult.key, activeResult.error);
		} catch (error) {
			listHost.replaceChildren(
				el("div", { style: { color: COLORS.error, fontSize: "13px" }, text: `读取失败：${error?.message ?? error}` }),
			);
		}
	}

	function renderList(keys, active, activeError) {
		const warning = activeError
			? el("div", {
					style: { color: COLORS.error, fontSize: "12px", marginBottom: "8px" },
					text: `无法读取「当前使用」标记：${activeError}`,
				})
			: null;

		if (keys.length === 0) {
			listHost.replaceChildren(
				...(warning ? [warning] : []),
				el("div", {
					style: { color: COLORS.dimmed, fontSize: "13px", padding: "10px 0" },
					text: "还没有保存任何 token。公开仓库不填也能用（每小时 60 次）。",
				}),
			);
			return;
		}

		const rows = keys.map((key) => {
			const isActive = key === active;
			const useButton = el("button", {
				type: "button",
				text: isActive ? "使用中" : "设为当前",
				disabled: isActive ? "" : undefined,
				style: isActive ? { ...buttonStyle("primary"), opacity: 0.6, cursor: "default" } : buttonStyle(),
			});
			if (!isActive) {
				useButton.addEventListener("click", async () => {
					useButton.disabled = true;
					try {
						await writeActiveKey(key);
						setStatus(`已切换到「${labelOf(key)}」`, "success");
						await refresh();
					} catch (error) {
						setStatus(`切换失败：${error?.message ?? error}`, "error");
						useButton.disabled = false;
					}
				});
			}

			/**
			 * Per-token identity check.
			 *
			 * The panel cannot read the secret (a UI session only gets `secrets.list`), and
			 * from the panel side a stale token and a missing one both look like "nothing
			 * happens". This asks the plugin backend — which can read the secret — to call
			 * GitHub, then renders only the account name, never the credential.
			 */
			const verifyResult = el("div", {
				style: { fontSize: "11px", color: COLORS.dimmed, marginTop: "4px", minHeight: "14px", whiteSpace: "pre-wrap" },
			});
			const verifyButton = el("button", { type: "button", text: "验证", style: buttonStyle() });
			verifyButton.addEventListener("click", async () => {
				// `commands.execute` only exists on a shell new enough to dispatch
				// plugin-declared commands. Say so instead of throwing a bare TypeError.
				if (typeof api.commands?.execute !== "function") {
					verifyResult.style.color = COLORS.error;
					verifyResult.textContent = "✗ 当前宿主版本不支持插件命令，无法验证。";
					return;
				}
				verifyButton.disabled = true;
				verifyResult.textContent = "正在验证…";
				verifyResult.style.color = COLORS.dimmed;
				try {
					const response = await api.commands.execute("verify-token", { key });
					const data = response?.output ?? response;
					if (data?.ok) {
						const scopes = Array.isArray(data.scopes)
							? data.scopes.join(", ")
							: "细粒度 token（未声明经典 scope）";
						verifyResult.style.color = COLORS.success;
						verifyResult.textContent = `✓ 有效 · 账号 ${data.login ?? "未知"}${
							data.rate_limit ? ` · 剩余 ${data.rate_limit.remaining}/${data.rate_limit.limit}` : ""
						}\nscope: ${scopes}`;
					} else {
						verifyResult.style.color = COLORS.error;
						verifyResult.textContent = `✗ ${data?.message ?? "验证失败"}`;
					}
				} catch (error) {
					verifyResult.style.color = COLORS.error;
					verifyResult.textContent = `✗ 验证请求失败：${error?.message ?? error}`;
				} finally {
					verifyButton.disabled = false;
				}
			});

			const removeButton = el("button", { type: "button", text: "删除", style: buttonStyle("danger") });
			removeButton.addEventListener("click", async () => {
				removeButton.disabled = true;
				try {
					await api.secrets.delete(key);
					const remaining = keys.filter((candidate) => candidate !== key);
					if (isActive) await writeActiveKey(remaining[0] ?? DEFAULT_KEY);
					setStatus(`已删除「${labelOf(key)}」`, "success");
					await refresh();
				} catch (error) {
					setStatus(`删除失败：${error?.message ?? error}`, "error");
					removeButton.disabled = false;
				}
			});

			return el(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: "10px",
						padding: "10px",
						marginBottom: "8px",
						border: `1px solid ${isActive ? COLORS.primary : COLORS.border}`,
						borderRadius: COLORS.radius,
						background: COLORS.surface,
					},
				},
				[
					el("div", { style: { flex: "1", minWidth: "0" } }, [
						el("div", { style: { fontWeight: "600", display: "flex", alignItems: "center", gap: "8px" } }, [
							el("span", { text: labelOf(key) }),
							isActive ? el("span", { style: { fontSize: "11px", color: COLORS.primary }, text: "● 当前" }) : "",
						]),
						el("div", {
							style: { fontSize: "11px", color: COLORS.dimmed, fontFamily: COLORS.mono, marginTop: "2px" },
							text: key,
						}),
						verifyResult,
					]),
					verifyButton,
					useButton,
					removeButton,
				],
			);
		});

		listHost.replaceChildren(
			el("div", { style: { fontSize: "12px", color: COLORS.dimmed, marginBottom: "8px" }, text: `已保存 ${keys.length} 个 token` }),
			...rows,
		);
	}

	// ---- add form ----
	const labelInput = el("input", { type: "text", placeholder: "标签，例如 work / personal（可留空）", style: { ...inputStyle(), marginBottom: "8px" } });
	const tokenInput = el("input", { type: "password", placeholder: "ghp_… 或 github_pat_…", style: { ...inputStyle(), marginBottom: "8px", fontFamily: COLORS.mono } });
	const saveButton = el("button", { type: "button", text: "保存并使用", style: buttonStyle("primary") });
	const openButton = el("button", { type: "button", text: "打开 GitHub Token 页", style: buttonStyle() });

	saveButton.addEventListener("click", async () => {
		const token = tokenInput.value.trim();
		if (token === "") {
			setStatus("请先填入 token 再保存。", "error");
			tokenInput.focus();
			return;
		}
		saveButton.disabled = true;
		setStatus("正在保存…");
		try {
			const slug = labelInput.value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
			const key = slug === "" ? DEFAULT_KEY : `${SECRET_PREFIX}__${slug}`;
			await api.secrets.set(key, token);
			// The secret is already stored; a failed marker write must not read as
			// "save failed", or the user re-enters a token that is in fact saved.
			let markerError = null;
			try {
				await writeActiveKey(key);
			} catch (error) {
				markerError = error?.message ?? String(error);
			}
			// Clear the secret value: leaving a token in a plain DOM input is a needless
			// exposure. Keep the label so the user can add a differently-named one next.
			tokenInput.value = "";
			if (markerError) {
				setStatus(
					`已保存「${slug === "" ? "默认" : slug}」，但设为当前使用失败：${markerError}`,
					"error",
				);
			} else {
				setStatus(`已保存「${slug === "" ? "默认" : slug}」并设为当前使用`, "success");
			}
			await refresh();
		} catch (error) {
			setStatus(`保存失败：${error?.message ?? error}`, "error");
		} finally {
			saveButton.disabled = false;
		}
	});

	openButton.addEventListener("click", () => {
		api.ui?.openExternal?.({ url: "https://github.com/settings/tokens" })?.catch?.((error) => {
			setStatus(`无法打开链接：${error?.message ?? error}`, "error");
		});
	});

	document.body.append(
		el("div", { style: { fontWeight: "600", marginBottom: "4px" }, text: "GitHub Token" }),
		el("div", {
			style: { fontSize: "12px", color: COLORS.dimmed, marginBottom: "12px", lineHeight: "1.6" },
			text: "可以保存多个 token，随时切换当前使用的那个。token 存在本机插件 secrets 里，只用于访问 api.github.com。",
		}),
		listHost,
		el("div", {
			style: { borderTop: `1px solid ${COLORS.border}`, paddingTop: "14px", marginTop: "4px" },
		}, [
			el("div", { style: { fontWeight: "600", marginBottom: "8px", fontSize: "13px" }, text: "新增 token" }),
			labelInput,
			tokenInput,
			el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, [saveButton, openButton]),
			status,
		]),
	);

	refresh();
}

boot();
