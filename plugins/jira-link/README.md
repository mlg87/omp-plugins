# jira-link

Keeps the Jira issue you're working on in view. When your git branch starts with a Jira key such
as `LM-23401`, a row below omp's input box shows that key, clickable to open the issue, followed by
the issue's live status and title:

```
LM-23401 · [In Progress] · Fix the checkout timeout
```

## What you get

- **The key from your branch.** `LM-23401-fix-thing` and `feature/LM-23401-fix-thing` both show
  `LM-23401`. Branches without a key (`main`) show nothing.
- **A clickable key.** With a Jira site configured, the key is a terminal hyperlink to
  `<site>/browse/<key>`; Cmd-click or Ctrl-click opens it in terminals that support hyperlinks.
- **Live status and title.** jira-link fetches them through the Atlassian MCP login omp already
  has, so there is no second login.
- **Stays current.** It checks at session start, polls the branch every 5 seconds, and re-fetches
  the issue each time the agent starts and finishes a turn.

## Install

```
/marketplace add mlg87/omp-plugins
/marketplace install jira-link@mlg87
```

Restart the omp session; omp loads extension modules only at startup. Skip the first line if you
already added the `mlg87` marketplace for another plugin.

Then point it at your Jira site:

```
/jira-link site example.atlassian.net
```

**For status and title**, omp needs an Atlassian MCP server at `https://mcp.atlassian.com/v2/mcp`
that you've logged into through omp, so its OAuth token is stored in omp's `agent.db`. Without it
the row shows only the key.

Without the marketplace, you can copy `src/jira-link.ts` into `~/.omp/agent/extensions/` instead.

## Commands

`/jira-link` with no arguments is the same as `/jira-link show`.

| Command | Effect |
|---|---|
| `/jira-link show` | Print the current key and status, the configured site, and which config sources are in effect. |
| `/jira-link site <url>` | Set the Jira site, e.g. `example.atlassian.net` or `https://jira.corp/jira`. `https://` is assumed if you leave out the scheme. Applies immediately. |
| `/jira-link reset` | Delete your user config, leaving the site unset (the key is shown as plain text). |

## Configuration

Commands save to your user config file. You can also edit that file by hand, commit a per-project
file, or use an environment variable.

| Key | Type | Default | Environment variable | Meaning |
|---|---|---|---|---|
| `site` | URL string | none | `JIRA_LINK_SITE` | Jira base URL the key links to. A context path (Jira Data Center) is kept. |

Sources, lowest to highest precedence:

1. User config: `~/.omp/agent/jira-link.json`, or `$PI_CODING_AGENT_DIR/jira-link.json` if you use
   a custom omp agent directory.
2. Project config: `<project>/.omp/jira-link.json`.
3. `JIRA_LINK_SITE`.

```json
{ "site": "https://example.atlassian.net" }
```

Hand edits take effect within one poll (5 seconds), with no restart. A malformed file, or a site
that isn't an http(s) URL, is ignored rather than breaking the session.

## How it works

- **Key:** `git symbolic-ref --short -q HEAD`, matched against
  `^(?:[^/]+/)?([A-Z][A-Z0-9]{1,9}-[0-9]{1,6})(?![A-Za-z0-9])`: an uppercase project key at the
  start of the branch, optionally after one `prefix/` segment.
- **Link:** an OSC 8 terminal hyperlink around the key. It's skipped when no site is set, and in
  terminals that are known to mishandle it (see [Limitations](#limitations)).
- **Auth:** jira-link opens omp's `agent.db` read-only and takes the newest `auth_credentials` row
  for `mcp_oauth:profile:<profile>:https://mcp.atlassian.com/v2/mcp`, where `<profile>` is your omp
  profile (`default` unless you use named profiles). The Jira cloud id comes from the token's `aud`
  claim (`ari:cloud:jira::site/<id>`).
- **Fetch:** an MCP `tools/call` of `getJiraIssue` with `fields: ["summary", "status"]`. The MCP
  session is reused across fetches; if the server answers 400 or 404 (the session expired), it
  starts a new session and retries once.
- **Failures:** a transient error (no token yet, network, server) keeps the cached title, drops the
  status, and retries on the next poll. An issue the server reports as not found isn't retried
  until the branch changes.
- **Safety:** titles are stripped of control characters and collapsed to one line, so remote text
  can't break the row or its hyperlink.

## Limitations

- **Interactive UI only.** In RPC, ACP, and print modes there's no row.
- **Detached HEAD shows nothing**, since there's no branch name to read.
- **Hyperlinks are a heuristic.** They're off inside GNU screen, inside tmux older than 3.4, in
  terminals whose `TERM` starts with `screen` or `tmux`, and in Warp. `PI_FORCE_HYPERLINKS=1` turns
  them on and `PI_NO_HYPERLINKS=1` off, same as omp.
- **omp owns the token.** jira-link never refreshes it. When it expires, the row drops the status
  (keeping the last title it fetched) until omp refreshes the login.
- **Self-contained module.** Its only runtime imports are `bun`, `bun:sqlite`, and `node:*`
  built-ins; omp packages are imported for types only, so the file works from a plugin cache or a
  bare `~/.omp/agent/extensions/` folder.

## Troubleshooting

- **No row at all.** Restart omp after installing, then check that `/plugins list` shows
  `jira-link@mlg87` as enabled. Your branch must start with an uppercase key (`LM-1-...`, not
  `lm-1-...`); `/jira-link show` reports `no issue on branch` otherwise.
- **The key isn't clickable.** `/jira-link show` should list a site. If it does, your terminal
  (or multiplexer) doesn't support hyperlinks; see [Limitations](#limitations).
- **Only the key, no status or title.** omp has no Atlassian MCP login for
  `https://mcp.atlassian.com/v2/mcp` in this profile, or the token expired. Log in to the
  Atlassian MCP server through omp; the row fills in on the next poll or turn.
- **A project links somewhere unexpected.** Run `/jira-link show`. A `<project>/.omp/jira-link.json`
  file or `JIRA_LINK_SITE` overrides your user config.

## Uninstall

```
/marketplace uninstall jira-link@mlg87
```

Your settings stay in `~/.omp/agent/jira-link.json`; delete it (or run `/jira-link reset` first)
for a clean removal.

## Development

```
bun install
bun run lint        # biome
bun run typecheck   # tsc --strict
bun run test        # bun test
```

To run your working copy in omp, link it and restart the session:

```
omp plugin link ./plugins/jira-link
```

Layout:

- `src/jira-link.ts` — the extension: branch-key parsing, config loading, the hyperlink policy and
  row truncation, reading omp's Atlassian credential, the MCP client, and the event and command
  wiring.
- `src/jira-link.test.ts` — tests for key parsing, token and credential reading, config precedence,
  site normalization, the hyperlink policy, truncation, the MCP client against a fake server
  (session reuse and re-initialization), and the extension wiring against a fake omp.

## Changelog

| Version | Change |
|---|---|
| 1.0.0 | Initial release: Jira key from the git branch below the composer, OSC 8 link to a configurable site, live status and title via omp's Atlassian MCP login, and `/jira-link` commands. |

## License

MIT
