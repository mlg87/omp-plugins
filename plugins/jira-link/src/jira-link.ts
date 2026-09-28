// Jira Link — a row below the composer showing the Jira key parsed from the current git branch
// (e.g. `LM-23401`), OSC-8 hyperlinked to the configured Jira site, followed by the issue's live
// `[status]` and title.
//
// WHY a widget below the editor: the key is ambient context for the whole session, not a message.
// `setWidget(..., { placement: "belowEditor" })` keeps it next to where the user types without
// entering the transcript or competing with the status line, and a string-array widget is the
// simplest shape omp accepts.
//
// WHY auth comes from `agent.db` rather than a second OAuth login: omp already holds an Atlassian
// OAuth token for its MCP server (`auth_credentials` row `mcp_oauth:profile:<profile>:<url>`), and
// the Jira cloud id is embedded in that token's `aud`. Reading it read-only means zero extra login
// flow, no second secret on disk, and omp stays the single owner of refresh. If the row is missing
// or stale the row degrades to the bare key.
//
// Refresh cadence: session start, a branch poll every `POLL_MS`, and each agent turn start/end.
// A transient fetch failure keeps the cached title and retries on the next poll; "not found" is
// definitive until the branch changes.
//
// Package imports are type-only (same rule as ask-pulse, `plugins/ask-pulse/src/ask-pulse.ts`):
// a bare runtime specifier from `~/.omp/agent/extensions/` or a plugin cache resolves to bun's
// package cache, where `@oh-my-pi/pi-tui`'s `pi_natives` addon is absent and fails to load — and
// tests must not load that addon either. Width measuring uses bun's own `stringWidth`, the
// hyperlink policy is a local port of pi-tui's, and the agent dir mirrors omp's resolution.
// Runtime builtins (`bun`, `bun:sqlite`, `node:*`) are exempt: they resolve from the runtime.

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent"
import { stringWidth } from "bun"

const ISSUE_KEY_RE = /^(?:[^/]+\/)?([A-Z][A-Z0-9]{1,9}-[0-9]{1,6})(?![A-Za-z0-9])/
const WIDGET_KEY = "jira-link"
const POLL_MS = 5000
const GIT_TIMEOUT_MS = 2000

const MCP_URL = "https://mcp.atlassian.com/v2/mcp"
/** omp's `mcpOAuthCredentialId`: `mcp_oauth:profile:<profile ?? "default">:<serverUrl>`. */
const MCP_PROVIDER = `mcp_oauth:profile:${process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? "default"}:${MCP_URL}`
const MCP_PROTOCOL_VERSION = "2025-06-18"
const FETCH_TIMEOUT_MS = 5000

const CONFIG_BASENAME = "jira-link.json"
/** The active profile's agent directory — `PI_CODING_AGENT_DIR` wins, matching omp's own resolution. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent")
const USER_CONFIG_PATH = join(AGENT_DIR, CONFIG_BASENAME)

const USAGE = [
  "Usage:",
  "  /jira-link show          current key, status, and site",
  "  /jira-link site <url>    set the Jira site, e.g. https://example.atlassian.net",
  "  /jira-link reset         remove the user config (site unset)",
].join("\n")

/** Narrow an unknown to a plain object for safe property access; null otherwise. */
function asRecord(value: unknown): Record<string, unknown> | null {
  // Safe assertion: guarded by the object/non-null check on the same line.
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

/** The Jira key a branch starts with, optionally after one `prefix/` segment; null otherwise. */
export function parseIssueKey(branch: string): string | null {
  return ISSUE_KEY_RE.exec(branch)?.[1] ?? null
}

// ─── Config ──────────────────────────────────────────────────────────────────────────────────

function readConfigFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {} // A hand-edited config with a typo must never break the session.
  }
}

export interface JiraLinkConfig {
  /** Jira base URL (`origin` + optional context path, no trailing slash); null = no hyperlink. */
  site: string | null
}

/**
 * `https://` is assumed when no scheme is given; only http(s) is accepted. The result is
 * `origin + pathname` without a trailing slash, so a Data Center context path survives.
 */
export function normalizeSite(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  if (value === "") return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "")
  } catch {
    return null
  }
}

/**
 * Precedence, lowest to highest: user config, project config, `JIRA_LINK_SITE`. A source whose
 * site does not normalize is skipped. Re-read on every poll, so a hand edit lands within one.
 */
export function loadConfig(cwd: string): JiraLinkConfig {
  const sources = [
    readConfigFile(USER_CONFIG_PATH).site,
    readConfigFile(join(cwd, ".omp", CONFIG_BASENAME)).site,
    process.env.JIRA_LINK_SITE,
  ]
  let site: string | null = null
  for (const source of sources) site = normalizeSite(source) ?? site
  return { site }
}

/** Persist a partial config to the user file, preserving unrelated keys. */
function writeUserConfig(patch: Record<string, unknown>): string {
  const merged = { ...readConfigFile(USER_CONFIG_PATH), ...patch }
  mkdirSync(AGENT_DIR, { recursive: true })
  writeFileSync(USER_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`)
  return USER_CONFIG_PATH
}

export function issueUrl(site: string, key: string): string {
  return `${site}/browse/${key}`
}

// ─── Terminal ────────────────────────────────────────────────────────────────────────────────

/**
 * Port of pi-tui's `shouldEnableHyperlinksByDefault` minus its terminal table: explicit overrides,
 * then the multiplexers that swallow OSC 8 (screen always; tmux before 3.4), then Warp.
 */
export function hyperlinksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_NO_HYPERLINKS === "1") return false
  if (env.PI_FORCE_HYPERLINKS === "1") return true
  if (env.STY) return false
  if (env.TMUX) {
    if (env.TERM_PROGRAM?.toLowerCase() !== "tmux") return false
    const m = /^(\d+)\.(\d+)/.exec(env.TERM_PROGRAM_VERSION ?? "")
    if (!m) return false
    const major = Number(m[1])
    const minor = Number(m[2])
    return major > 3 || (major === 3 && minor >= 4)
  }
  const term = env.TERM?.toLowerCase() ?? ""
  if (term.startsWith("screen") || term.startsWith("tmux")) return false
  if (env.TERM_PROGRAM === "WarpTerminal") return false
  return true
}

const HYPERLINKS = hyperlinksEnabled()

/** CSI (`ESC [ … final`) and OSC (`ESC ] … BEL|ST`) sequences: zero width, never split. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point.
const ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y

/**
 * Fit `text` into `width` cells, ending in `…` when cut. Escape sequences are copied through
 * whole — including those after the cut — so a style reset or an OSC-8 close is never lost.
 */
export function truncateRow(text: string, width: number): string {
  if (stringWidth(text) <= width) return text
  const budget = width - 1
  let out = ""
  let used = 0
  let cut = false
  let i = 0
  while (i < text.length) {
    ESCAPE_RE.lastIndex = i
    const esc = ESCAPE_RE.exec(text)
    if (esc) {
      out += esc[0]
      i += esc[0].length
      continue
    }
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0)
    i += ch.length
    if (cut) continue
    const w = stringWidth(ch)
    if (used + w > budget) {
      cut = true
      out += "…"
      continue
    }
    out += ch
    used += w
  }
  return out
}

// ─── Atlassian MCP ───────────────────────────────────────────────────────────────────────────

/** The Jira cloud id from a token's `aud` (`ari:cloud:jira::site/<id>`); null when absent. */
export function cloudIdFromToken(token: string): string | null {
  try {
    const seg = token.split(".")[1]
    if (!seg) return null
    const payload = asRecord(JSON.parse(Buffer.from(seg, "base64url").toString("utf8")))
    const aud = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud]
    for (const entry of aud) {
      const m = /^ari:cloud:jira::site\/([0-9a-f-]+)$/.exec(String(entry))
      if (m?.[1]) return m[1]
    }
    return null
  } catch {
    return null
  }
}

export interface AtlassianAuth {
  token: string
  cloudId: string
}

/**
 * Read the Atlassian OAuth access token omp stores for its MCP login and the Jira cloud id
 * embedded in that token. Read-only; never writes and never refreshes (omp owns the refresh
 * lifecycle). Any failure degrades to null.
 */
export function readAtlassianAuth(dbPath = join(AGENT_DIR, "agent.db"), provider = MCP_PROVIDER): AtlassianAuth | null {
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const row = db
      .query<{ data: string }, [string]>(
        "SELECT data FROM auth_credentials WHERE provider = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(provider)
    if (!row) return null
    const token = asRecord(JSON.parse(row.data))?.access
    if (typeof token !== "string" || !token) return null
    const cloudId = cloudIdFromToken(token)
    return cloudId ? { token, cloudId } : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

/** Endpoint and credential source; swapped only by tests. */
let transport: { url: string; auth: () => AtlassianAuth | null } = { url: MCP_URL, auth: () => readAtlassianAuth() }
let mcpSessionId: string | null = null

/** Test seam: point the MCP client at a fake server and credential source; drops the session. */
export function __setTransportForTests(t: Partial<typeof transport>): void {
  transport = { ...transport, ...t }
  mcpSessionId = null
}

function mcpPost(token: string, body: unknown, sessionId: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  }
  if (sessionId) headers["Mcp-Session-Id"] = sessionId
  return fetch(transport.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

async function mcpInitialize(token: string): Promise<string | null> {
  const res = await mcpPost(
    token,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "omp-jira-link", version: "1.0.0" },
      },
    },
    null,
  )
  if (!res.ok) return null
  const sessionId = res.headers.get("mcp-session-id")
  if (!sessionId) return null
  await mcpPost(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId).catch(() => {})
  return sessionId
}

/** Parse a JSON-RPC response body that may arrive as raw JSON or an SSE stream. */
export function parseJsonRpcBody(text: string): unknown {
  const trimmed = text.trimStart()
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue
      try {
        return JSON.parse(line.slice(5).trim())
      } catch {
        // try the next data line
      }
    }
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Strip control bytes and collapse whitespace so remote text can't break the OSC-8 row. */
export function sanitizeSingleLine(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the point.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

export type IssueData = { title: string; status: string }
export type IssueResult = IssueData | "notfound" | "error"

export async function fetchIssue(key: string): Promise<IssueResult> {
  try {
    const auth = transport.auth()
    if (!auth) return "error"
    if (!mcpSessionId) mcpSessionId = await mcpInitialize(auth.token)
    if (!mcpSessionId) return "error"

    const body = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "getJiraIssue",
        arguments: { cloudId: auth.cloudId, issueIdOrKey: key, fields: ["summary", "status"] },
      },
    }
    let res = await mcpPost(auth.token, body, mcpSessionId)
    if (res.status === 400 || res.status === 404) {
      // The server forgot the session (restart, expiry): start a new one and retry once.
      mcpSessionId = await mcpInitialize(auth.token)
      if (!mcpSessionId) return "error"
      res = await mcpPost(auth.token, body, mcpSessionId)
    }
    if (!res.ok) return "error"

    const rpc = asRecord(parseJsonRpcBody(await res.text()))
    const result = asRecord(rpc?.result)
    if (!result) return "error"
    if (result.isError === true) return "notfound"
    const content = result.content
    const first = Array.isArray(content) ? asRecord(content[0]) : null
    if (typeof first?.text !== "string") return "notfound"
    const fields = asRecord(asRecord(asRecord(JSON.parse(first.text))?.data)?.fields)
    const rawTitle = fields?.summary
    const rawStatus = asRecord(fields?.status)?.name
    if (typeof rawTitle !== "string" || !rawTitle) return "notfound"
    if (typeof rawStatus !== "string" || !rawStatus) return "notfound"
    return { title: sanitizeSingleLine(rawTitle), status: rawStatus.replace(/_/g, " ") }
  } catch {
    return "error"
  }
}

// ─── Extension ───────────────────────────────────────────────────────────────────────────────

export default function jiraLinkExtension(pi: ExtensionAPI) {
  let config: JiraLinkConfig = { site: null }
  let shownKey: string | null = null
  let status: string | null = null
  let issueInFlight = false
  let needRetry = false
  let timer: Timer | undefined
  const titles = new Map<string, string>()

  async function currentBranch(ctx: ExtensionContext): Promise<string | null> {
    try {
      const result = await pi.exec("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
        cwd: ctx.cwd,
        timeout: GIT_TIMEOUT_MS,
      })
      if (result.code !== 0) return null
      return result.stdout.trim() || null
    } catch {
      return null
    }
  }

  function issueLink(key: string): string {
    if (config.site === null || !HYPERLINKS) return key
    return `\x1b]8;;${issueUrl(config.site, key)}\x07${key}\x1b]8;;\x07`
  }

  function renderRow(ctx: ExtensionContext, key: string): string {
    const head = ctx.ui.theme.fg("accent", issueLink(key))
    const parts = [head]
    if (status) parts.push(ctx.ui.theme.fg("warning", `[${status}]`))
    const title = titles.get(key)
    if (title) parts.push(title)
    const width = Math.max(20, (process.stdout.columns ?? 120) - 2)
    // Never cut the key itself: if even it doesn't fit, let the terminal wrap it.
    if (stringWidth(head) >= width) return head
    return truncateRow(parts.join(" · "), width)
  }

  function paint(ctx: ExtensionContext): void {
    ctx.ui.setWidget(WIDGET_KEY, shownKey ? [renderRow(ctx, shownKey)] : undefined, {
      placement: "belowEditor",
    })
  }

  async function refreshIssue(ctx: ExtensionContext): Promise<void> {
    const key = shownKey
    if (!key || issueInFlight) return
    issueInFlight = true
    try {
      const issue = await fetchIssue(key)
      if (shownKey !== key) return
      if (typeof issue === "object") {
        titles.set(key, issue.title)
        status = issue.status
        needRetry = false
      } else {
        // "error" is transient (auth not warm, transport) → keep cached title, drop stale status,
        // retry on the next poll. "notfound" is definitive.
        status = null
        needRetry = issue === "error"
      }
      paint(ctx)
    } finally {
      issueInFlight = false
    }
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return
    const previousSite = config.site
    config = loadConfig(ctx.cwd)
    const branch = await currentBranch(ctx)
    const key = branch ? parseIssueKey(branch) : null
    if (key === shownKey) {
      if (config.site !== previousSite) paint(ctx)
      // Same key: retry the poll only while the last fetch failed transiently.
      if (key && needRetry) void refreshIssue(ctx)
      return
    }
    shownKey = key
    status = null
    needRetry = false
    paint(ctx)
    if (key) void refreshIssue(ctx)
  }

  function armPoll(ctx: ExtensionContext): void {
    if (timer) ctx.clearTimer(timer)
    timer = ctx.setInterval(() => {
      void refresh(ctx)
    }, POLL_MS)
  }

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx)
    armPoll(ctx)
  })

  pi.on("session_switch", async (_event, ctx) => {
    shownKey = null
    status = null
    await refresh(ctx)
    armPoll(ctx)
  })

  // A prompt was submitted (agent turn begins): refresh eagerly so status/title appear at the
  // start of the turn, not only when it ends.
  pi.on("agent_start", async (_event, ctx) => {
    await refreshIssue(ctx)
  })

  pi.on("agent_end", async (_event, ctx) => {
    await refreshIssue(ctx)
  })

  pi.registerCommand("jira-link", {
    description: "Show or configure the Jira link row",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [subcommand = "show", ...rest] = args.trim().split(/\s+/).filter(Boolean)
      const value = rest.join(" ")

      switch (subcommand) {
        case "show": {
          config = loadConfig(ctx.cwd)
          const projectPath = join(ctx.cwd, ".omp", CONFIG_BASENAME)
          const origins = [
            existsSync(USER_CONFIG_PATH) ? `user config ${USER_CONFIG_PATH}` : undefined,
            existsSync(projectPath) ? `project config ${projectPath}` : undefined,
            process.env.JIRA_LINK_SITE !== undefined ? "JIRA_LINK_SITE" : undefined,
          ].filter(Boolean)
          ctx.ui.notify(
            `jira-link ${shownKey ?? "no issue on branch"}${status ? ` [${status}]` : ""}, site ${config.site ?? "unset"}` +
              (origins.length > 0 ? ` (${origins.join(", ")})` : " (defaults)"),
          )
          return
        }
        case "site": {
          const site = normalizeSite(value)
          if (site === null) {
            ctx.ui.notify(`Unrecognized site "${value}". Use e.g. https://example.atlassian.net`, "error")
            return
          }
          const path = writeUserConfig({ site })
          config = loadConfig(ctx.cwd)
          paint(ctx)
          ctx.ui.notify(`jira-link site → ${site} (${path})`)
          return
        }
        case "reset": {
          if (existsSync(USER_CONFIG_PATH)) rmSync(USER_CONFIG_PATH)
          config = loadConfig(ctx.cwd)
          paint(ctx)
          ctx.ui.notify("jira-link reset (site unset)")
          return
        }
        default:
          ctx.ui.notify(`Unknown subcommand "${subcommand}".\n${USAGE}`, "warning")
      }
    },
  })
}
