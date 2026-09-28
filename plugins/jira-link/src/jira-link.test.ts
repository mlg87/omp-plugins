// Branch parsing, token/credential reading, site config, hyperlink policy, the MCP client against
// a fake server, and the widget/command wiring. `AGENT_DIR` and the hyperlink policy are resolved
// once at module init, so the environment must be set before the module under test is imported —
// hence the dynamic import below. Hyperlinks are forced on so wiring assertions don't depend on
// the terminal running the tests.
import { Database } from "bun:sqlite"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stringWidth } from "bun"

const workspace = mkdtempSync(join(tmpdir(), "jira-link-"))
const agentDir = join(workspace, "agent")
const projectDir = join(workspace, "project")
mkdirSync(join(projectDir, ".omp"), { recursive: true })
mkdirSync(agentDir, { recursive: true })
process.env.PI_CODING_AGENT_DIR = agentDir
delete process.env.JIRA_LINK_SITE
delete process.env.PI_NO_HYPERLINKS
delete process.env.TMUX
delete process.env.STY
process.env.PI_FORCE_HYPERLINKS = "1"

// Dynamic, not static: a static import is hoisted above the env setup it depends on.
const {
  default: jiraLink,
  parseIssueKey,
  cloudIdFromToken,
  readAtlassianAuth,
  parseJsonRpcBody,
  sanitizeSingleLine,
  normalizeSite,
  loadConfig,
  hyperlinksEnabled,
  truncateRow,
  fetchIssue,
  __setTransportForTests,
} = await import("./jira-link.ts")

const userConfig = join(agentDir, "jira-link.json")
const projectConfig = join(projectDir, ".omp", "jira-link.json")

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

const jwt = (payload: unknown) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`

describe("parseIssueKey", () => {
  test("reads a leading key, optionally after one prefix segment", () => {
    expect(parseIssueKey("LM-23401-fix-thing")).toBe("LM-23401")
    expect(parseIssueKey("feature/ABC-1-x")).toBe("ABC-1")
  })

  test("rejects keys glued to more alphanumerics, non-key branches, and lowercase", () => {
    expect(parseIssueKey("LM-23401a")).toBeNull()
    expect(parseIssueKey("main")).toBeNull()
    expect(parseIssueKey("lm-1")).toBeNull()
  })
})

describe("cloudIdFromToken", () => {
  test("finds the Jira site in an aud array or string", () => {
    expect(cloudIdFromToken(jwt({ aud: ["ari:cloud:jira::site/1234-abcd", "other"] }))).toBe("1234-abcd")
    expect(cloudIdFromToken(jwt({ aud: "ari:cloud:jira::site/1234-abcd" }))).toBe("1234-abcd")
  })

  test("null without a matching aud or for garbage", () => {
    expect(cloudIdFromToken(jwt({ aud: ["other"] }))).toBeNull()
    expect(cloudIdFromToken("not-a-jwt")).toBeNull()
    expect(cloudIdFromToken("a.!!!.b")).toBeNull()
  })
})

describe("readAtlassianAuth", () => {
  const provider = "mcp_oauth:profile:default:https://mcp.atlassian.com/v2/mcp"
  const dbPath = join(workspace, "agent-test.db")
  const oldToken = jwt({ aud: "ari:cloud:jira::site/0000-dead" })
  const newToken = jwt({ aud: "ari:cloud:jira::site/1111-beef" })

  test("the newest row for the provider wins", () => {
    const db = new Database(dbPath, { create: true })
    db.run("CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, data TEXT, updated_at INTEGER)")
    const insert = db.query("INSERT INTO auth_credentials VALUES (?, 'oauth', ?, ?)")
    insert.run(provider, JSON.stringify({ access: newToken }), 200)
    insert.run(provider, JSON.stringify({ access: oldToken }), 100)
    db.close()
    expect(readAtlassianAuth(dbPath, provider)).toEqual({ token: newToken, cloudId: "1111-beef" })
  })

  test("null for a missing row or a missing database", () => {
    expect(readAtlassianAuth(dbPath, "mcp_oauth:profile:other:x")).toBeNull()
    expect(readAtlassianAuth(join(workspace, "absent.db"), provider)).toBeNull()
  })
})

describe("parseJsonRpcBody", () => {
  test("raw JSON and SSE data lines", () => {
    expect(parseJsonRpcBody('{"id":1}')).toEqual({ id: 1 })
    expect(parseJsonRpcBody('event: message\ndata: {"id":2}\n\n')).toEqual({ id: 2 })
  })

  test("malformed → null", () => {
    expect(parseJsonRpcBody("{nope")).toBeNull()
    expect(parseJsonRpcBody("data: {nope\n\n")).toBeNull()
  })
})

test("sanitizeSingleLine strips control bytes and collapses whitespace", () => {
  const out = sanitizeSingleLine("a\x1b]8;;x\x07b\n c")
  expect(out).toBe("a ]8;;x b c")
})

describe("normalizeSite", () => {
  test("assumes https, strips trailing slashes, keeps a context path", () => {
    expect(normalizeSite("guild.atlassian.net")).toBe("https://guild.atlassian.net")
    expect(normalizeSite("https://guild.atlassian.net/")).toBe("https://guild.atlassian.net")
    expect(normalizeSite("https://jira.corp/jira/")).toBe("https://jira.corp/jira")
  })

  test("rejects non-http schemes, empty strings, and non-strings", () => {
    expect(normalizeSite("ftp://x")).toBeNull()
    expect(normalizeSite("")).toBeNull()
    expect(normalizeSite(42)).toBeNull()
  })
})

describe("loadConfig", () => {
  afterEach(() => {
    rmSync(userConfig, { force: true })
    rmSync(projectConfig, { force: true })
    delete process.env.JIRA_LINK_SITE
  })

  test("no sources → site unset", () => {
    expect(loadConfig(projectDir)).toEqual({ site: null })
  })

  test("user < project < environment", () => {
    writeFileSync(userConfig, JSON.stringify({ site: "https://a" }))
    expect(loadConfig(projectDir).site).toBe("https://a")
    writeFileSync(projectConfig, JSON.stringify({ site: "https://b" }))
    expect(loadConfig(projectDir).site).toBe("https://b")
    process.env.JIRA_LINK_SITE = "https://c"
    expect(loadConfig(projectDir).site).toBe("https://c")
  })

  test("malformed project JSON and invalid sites fall through to lower sources", () => {
    writeFileSync(userConfig, JSON.stringify({ site: "https://a" }))
    writeFileSync(projectConfig, "{ site: ")
    expect(loadConfig(projectDir).site).toBe("https://a")
    process.env.JIRA_LINK_SITE = "ftp://nope"
    expect(loadConfig(projectDir).site).toBe("https://a")
  })
})

describe("hyperlinksEnabled", () => {
  test.each([
    [{}, true],
    [{ PI_NO_HYPERLINKS: "1", PI_FORCE_HYPERLINKS: "1" }, false],
    [{ STY: "1" }, false],
    [{ TMUX: "1", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.4" }, true],
    [{ TMUX: "1", TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.3" }, false],
    [{ TMUX: "1" }, false],
    [{ TERM: "screen-256color" }, false],
    [{ TERM_PROGRAM: "WarpTerminal" }, false],
  ] as const)("%o → %p", (env, expected) => {
    expect(hyperlinksEnabled(env as NodeJS.ProcessEnv)).toBe(expected)
  })
})

describe("truncateRow", () => {
  test("fits → unchanged", () => {
    expect(truncateRow("LM-1 · title", 40)).toBe("LM-1 · title")
  })

  test("too wide → cut with an ellipsis within the width", () => {
    const out = truncateRow("LM-1 · a rather long issue title here", 12)
    expect(out.endsWith("…")).toBe(true)
    expect(stringWidth(out)).toBeLessThanOrEqual(12)
  })

  test("escape sequences survive the cut whole, including the link close", () => {
    const link = "\x1b]8;;https://a/browse/LM-1\x07LM-1\x1b]8;;\x07"
    const out = truncateRow(`${link} · a rather long issue title here`, 12)
    expect(out.startsWith(link)).toBe(true)
    expect(stringWidth(out)).toBeLessThanOrEqual(12)
  })
})

/**
 * A fake Atlassian MCP endpoint: `initialize` issues a session; `tools/call` demands it (400
 * without, 404 once `forget` is set) and answers over SSE.
 */
interface FakeMcp {
  server: ReturnType<typeof Bun.serve>
  state: { initializes: number; calls: { auth: string | null; args: unknown }[]; forget: boolean; isError: boolean }
  url: string
}

function fakeMcp(summary = "Fix the\nthing", statusName = "In_Progress"): FakeMcp {
  const state: FakeMcp["state"] = { initializes: 0, calls: [], forget: false, isError: false }
  let session = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const rpc = (await req.json()) as { method: string; params?: { arguments?: unknown } }
      if (rpc.method === "initialize") {
        state.initializes++
        session++
        state.forget = false
        return new Response("{}", { headers: { "mcp-session-id": `s${session}` } })
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 })
      const sid = req.headers.get("mcp-session-id")
      if (!sid) return new Response("missing session", { status: 400 })
      if (state.forget || sid !== `s${session}`) return new Response("unknown session", { status: 404 })
      state.calls.push({ auth: req.headers.get("authorization"), args: rpc.params?.arguments })
      const text = JSON.stringify({ data: { fields: { summary, status: { name: statusName } } } })
      const result = state.isError ? { isError: true, content: [] } : { content: [{ type: "text", text }] }
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  return { server, state, url: `http://127.0.0.1:${server.port}/mcp` }
}

describe("fetchIssue", () => {
  let fake: FakeMcp
  beforeEach(() => {
    fake = fakeMcp()
    __setTransportForTests({ url: fake.url, auth: () => ({ token: "t", cloudId: "c" }) })
  })
  afterEach(() => fake.server.stop(true))

  test("fetches title and status over an initialized session", async () => {
    expect(await fetchIssue("LM-1")).toEqual({ title: "Fix the thing", status: "In Progress" })
    expect(fake.state.calls).toEqual([
      { auth: "Bearer t", args: { cloudId: "c", issueIdOrKey: "LM-1", fields: ["summary", "status"] } },
    ])
  })

  test("reuses the session, and re-initializes once the server forgets it", async () => {
    await fetchIssue("LM-1")
    await fetchIssue("LM-1")
    expect(fake.state.initializes).toBe(1)
    fake.state.forget = true
    expect(await fetchIssue("LM-1")).toEqual({ title: "Fix the thing", status: "In Progress" })
    expect(fake.state.initializes).toBe(2)
  })

  test("a tool error is notfound", async () => {
    fake.state.isError = true
    expect(await fetchIssue("LM-404")).toBe("notfound")
  })

  test("missing auth or an unreachable server is error", async () => {
    __setTransportForTests({ auth: () => null })
    expect(await fetchIssue("LM-1")).toBe("error")
    fake.server.stop(true)
    __setTransportForTests({ auth: () => ({ token: "t", cloudId: "c" }) })
    expect(await fetchIssue("LM-1")).toBe("error")
  })
})

describe("extension wiring", () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<void>
  type CommandHandler = (args: string, ctx: unknown) => Promise<void>

  let fake: FakeMcp
  beforeEach(() => {
    fake = fakeMcp("Title", "Done")
    __setTransportForTests({ url: fake.url, auth: () => ({ token: "t", cloudId: "c" }) })
  })
  afterEach(() => {
    fake.server.stop(true)
    rmSync(userConfig, { force: true })
    delete process.env.JIRA_LINK_SITE
  })

  /** Boot against a fake `pi` whose `git` answers with `branch` (or fails with a null branch). */
  const boot = (branch: string | null) => {
    const handlers = new Map<string, Handler>()
    let command: CommandHandler | undefined
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, handler)
      },
      registerCommand(_name: string, opts: { handler: CommandHandler }) {
        command = opts.handler
      },
      exec: async () => (branch === null ? { code: 1, stdout: "" } : { code: 0, stdout: `${branch}\n` }),
    }
    const widgets: (string[] | undefined)[] = []
    // Resolved by `setWidget` itself: the issue fetch is fire-and-forget, so the repaint is the signal.
    const waiters: { count: number; resolve: () => void }[] = []
    const painted = (count: number) =>
      new Promise<void>((resolve) => {
        if (widgets.length >= count) resolve()
        else waiters.push({ count, resolve })
      })
    const notes: string[] = []
    const ctx = {
      hasUI: true,
      cwd: projectDir,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setWidget(_key: string, rows: string[] | undefined) {
          widgets.push(rows)
          for (const w of waiters) if (widgets.length >= w.count) w.resolve()
        },
        notify(message: string) {
          notes.push(message)
        },
      },
      setInterval: () => 1 as unknown as Timer,
      clearTimer() {},
    }
    jiraLink(pi as never)
    return {
      widgets,
      notes,
      painted,
      emit: (event: string) => handlers.get(event)?.({}, ctx),
      run: (args: string) => command?.(args, ctx),
    }
  }

  test("shows key, status, and title; plain key without a site", async () => {
    const { widgets, emit, painted } = boot("LM-7-x")
    await emit("session_start")
    await painted(2)
    expect(widgets.at(-1)).toEqual(["LM-7 · [Done] · Title"])
  })

  test("with a site the key is an OSC-8 link", async () => {
    process.env.JIRA_LINK_SITE = "https://a"
    const { widgets, emit, painted } = boot("LM-7-x")
    await emit("session_start")
    await painted(2)
    expect(widgets.at(-1)?.[0]).toContain("\x1b]8;;https://a/browse/LM-7\x07LM-7\x1b]8;;\x07")
  })

  test("no key on the branch, or git failing, clears the widget", async () => {
    const main = boot("main")
    await main.emit("session_start")
    expect(main.widgets).toEqual([undefined])

    const detached = boot(null)
    await detached.emit("session_start")
    expect(detached.widgets).toEqual([undefined])
  })

  test("/jira-link site writes the user config; reset removes it", async () => {
    const { notes, run } = boot("main")
    await run("site foo.atlassian.net")
    expect(JSON.parse(readFileSync(userConfig, "utf8"))).toEqual({ site: "https://foo.atlassian.net" })
    expect(notes.at(-1)).toBe(`jira-link site → https://foo.atlassian.net (${userConfig})`)

    await run("site ftp://nope")
    expect(notes.at(-1)).toContain('Unrecognized site "ftp://nope"')

    await run("reset")
    expect(existsSync(userConfig)).toBe(false)
    expect(notes.at(-1)).toBe("jira-link reset (site unset)")
  })
})
