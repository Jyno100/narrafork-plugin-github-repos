# NarraFork GitHub Repos Plugin

A [NarraFork](https://github.com/Jyno100) plugin that lets the assistant read and search
GitHub: list repositories, browse directories, read files, list issues, search code, and
post issue comments — all through the host's tool protocol, with per-label token
management and a settings panel.

## Features

**11 tools**, all available to the model:

| Tool | What it does |
| --- | --- |
| `github_token_add` | Save a token under a label and make it active |
| `github_token_list` | List saved labels (never the token values) and mark the active one |
| `github_token_use` | Switch the active token |
| `github_token_remove` | Delete a saved token |
| `github_list_repos` | List repos for a user/org, or the token's own account |
| `github_list_issues` | List issues and/or pull requests |
| `github_issue_detail` | Read one issue or PR |
| `github_create_issue_comment` | Comment on an issue or PR (needs write scope) |
| `github_list_dir` | List a directory in a repo |
| `github_get_file` | Read a text file from a repo |
| `github_search_code` | Search code with full qualifier support |

**Token panel** (`workspace` / `director` / `focus` surfaces, plus a `settings` entry):

- Save multiple tokens under labels, switch between them, delete them.
- **Verify** a token: the panel asks the plugin backend to call GitHub and reports the
  account the token belongs to, its scopes, and the remaining rate limit. A stale token
  and a missing token both produce a bare `401` from every tool, so this makes
  "which account is this label?" answerable without ever revealing the credential.
- Tokens live in the host's plugin secret store, never in the panel, never in logs.

## Install

Build a `.nfplugin` (a zip of `manifest.json`, `server/`, and `ui/`), drop it into the
host's plugin import directory, and install it from the NarraFork UI. Or install from a
release asset on this repository.

## Tokens

A classic personal access token with `repo` scope covers private repositories and issue
comments; public-only usage works without a token at 60 requests/hour. Create tokens at
[github.com/settings/tokens](https://github.com/settings/tokens) — the panel has a button
for that.

Fine-grained tokens are supported too. Note that they report no classic scope list, so
the verify result says so explicitly rather than showing an empty (and misleading) scope
field.

## Layout

```
manifest.json      plugin manifest (strict schema — no extra top-level keys)
server/index.mjs   stdio JSON-RPC server: tools + the verify-token command
ui/view.js         the token panel (plain DOM, no framework runtime)
```

The server speaks the host's `narrafork.rpc/1` protocol over stdio with
`Content-Length` framing, answering `tools.invoke` and `commands.invoke` and calling back
into the host for `secrets.*` and `storage.*`.

## License

MIT — see [LICENSE](LICENSE).
