# mlg87 omp plugins

A small collection of plugins for [omp](https://github.com/oh-my-pi/pi-coding-agent), published as
the `mlg87` plugin marketplace. Each plugin is independent: install only the ones you want.

## Plugins

| Plugin | What it does |
|---|---|
| [`ask-pulse`](plugins/ask-pulse) | Frames the agent's last reply and the input box in an animated banner whenever the agent is waiting for you, so a finished turn is impossible to miss. |
| [`jira-link`](plugins/jira-link) | Shows the Jira issue from your git branch below the composer: a clickable key, live status, and title via omp's Atlassian MCP login. |
| [`obvi-plan`](plugins/obvi-plan) | Tints the terminal background while plan mode is active (midnight by default) and restores your own background when you leave it. |

Each plugin's README covers what it does in detail, its commands and configuration, its known
limitations, and its changelog.

## Install

Add the marketplace once:

```
/marketplace add mlg87/omp-plugins
```

Then install any plugin by name:

```
/marketplace install ask-pulse@mlg87
/marketplace install jira-link@mlg87
/marketplace install obvi-plan@mlg87
```

Restart the omp session afterwards: omp loads extension modules only at startup.

- **Browse:** `/marketplace discover mlg87` lists every plugin in this marketplace, and
  `/marketplace` with no arguments opens omp's interactive browser.
- **Per project:** add `--scope project` to `install` to enable a plugin for the current project
  only instead of for every project.
- **From the shell:** every command has a CLI form, e.g.
  `omp plugin marketplace add mlg87/omp-plugins` and `omp plugin install obvi-plan@mlg87`.

## Updating

```
/marketplace update mlg87          # refresh the catalog
/marketplace upgrade               # upgrade every installed plugin that has a newer catalog version
```

By default omp only notes available updates in its debug log. To have updates installed
automatically at startup:

```
omp config set marketplace.autoUpdate auto
```

## Disabling and removing

```
/plugins disable obvi-plan@mlg87          # keep it installed but stop loading it
/plugins enable obvi-plan@mlg87
/marketplace uninstall obvi-plan@mlg87    # remove it
/marketplace remove mlg87                 # forget the marketplace (installed plugins stay)
```

Each plugin keeps its own settings file in `~/.omp/agent/` (named after the plugin), which
uninstalling leaves in place; delete it by hand if you want a clean slate.

## Repository layout

```
.omp-plugin/marketplace.json     marketplace catalog read by omp
.claude-plugin/marketplace.json  identical copy, the Claude Code-compatible fallback location
plugins/
  <name>/
    package.json                 declares the extension entry point under "omp.extensions"
    src/                         extension source and its tests
    README.md                    plugin documentation
```

Each plugin is a self-contained Bun + TypeScript package with its own lockfile, lint
([Biome](https://biomejs.dev)), strict typecheck, and `bun test` suite. The only shared state is the
catalog.

## Development

Work on a plugin from its own directory:

```
cd plugins/<name>
bun install
bun run lint        # biome
bun run typecheck   # tsc --strict
bun run test        # bun test
```

To try local changes in omp, either link one plugin straight from your checkout:

```
omp plugin link ./plugins/<name>
```

or install from this checkout as a local marketplace:

```
/marketplace add ./omp-plugins
/marketplace install --force <name>@mlg87
```

Restart the session after either.

### Adding a plugin

1. Create `plugins/<name>/` with a `package.json` whose `omp.extensions` lists the entry module
   (see an existing plugin for the Biome, tsconfig, and script setup).
2. Add an entry to `plugins` in **both** catalog files with `"source": "./<name>"` (the catalog's
   `metadata.pluginRoot` is `./plugins`), a `version`, and a description.
3. Add a row to the table above and write the plugin's README.

### Releasing

A release is one PR that:

1. bumps `version` in the plugin's `package.json`;
2. bumps the same `version` in both catalog files, which must stay identical;
3. adds a row to the changelog in the plugin's README.

`omp plugin upgrade` compares catalog versions, so users only receive a release once the catalog
says so.

## License

MIT, see [LICENSE](LICENSE). Each plugin also ships its own copy.
