import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit, Register } from 'claude-code'

import type { Balance, UiLang, Usage } from '../types'

// Four tools that use DeepSeek as Claude's worker, plus a usage status line.
// Runs inside Claude Code with no separate server: files go through $.fs, short API calls through $.http.
// $.http.fetch must finish within 30 seconds, so long generations run through curl and are streamed
// (curl ships with macOS, Linux and Windows 10+).
//
// Text the model reads (tool descriptions, Claude's guide, DeepSeek prompts, tool results and errors) is English.
// Text people read (status line, /deepseek-usage) comes in English or Korean; see the `language` option.

type Args = Record<string, unknown>
type EnvName = 'HOME' | 'USERPROFILE' | 'SystemRoot' | 'DEEPSEEK_BASE_URL' | 'DEEPSEEK_MODEL' | 'LC_ALL' | 'LC_MESSAGES' | 'LANG'

// The engine ($) is only usable inside hooks, so the tool code gets just the pieces it needs
type IO = {
  fetch: (url: string, init: HttpInit) => Promise<{ status: number; ok: boolean; text: string }>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  // The real path with links followed; undefined when the path does not exist
  realPath: (path: string) => Promise<string | undefined>
  cwd: () => Promise<string>
  // What Claude Code would decide if Claude used the Read/Write tool on this path (asks only; no dialog)
  check: (tool: 'Read' | 'Write', filePath: string) => Promise<{ decision: string; reason?: string }>
  env: (name: EnvName) => Promise<string | undefined>
  // Starts a command and yields its output in pieces (input goes to stdin)
  spawn: (argv: string[], input: string) => AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>
  record: (used: Used[], bal: Bal | undefined) => Promise<void>
}

const PLUGIN = 'deepseek-worker'
const TOOL = (name: string) => `mcp__${PLUGIN}__${name}`

// ───────── Text the model reads ─────────

// Sent with every request. A `system` argument is appended after it.
const COMMON_SYSTEM = `You are a worker handling one task delegated by a higher-level agent (Claude). Your output is read and reviewed by that agent, not by a person.
- Output only what was asked: no greetings, preamble, closing remarks or unrequested summaries.
- If information is missing, don't make it up; state any assumptions briefly at the end.
- Stay within the requested scope: no unrequested changes, features or additions.
- Write prose, code comments and messages in the language of the request, unless the request says otherwise.`
const FILE_ONLY_INSTRUCTION =
  '\n\nYour entire reply is saved to a file as-is. Output only the file content, with no explanation and no code fences (```).' +
  " Don't list assumptions; pick the most reasonable option."
const FENCE_RE = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/

// Usage guide for Claude (one section of its system prompt)
const GUIDE = `# DeepSeek worker (deepseek_chat · deepseek_batch · deepseek_research)
If the user says to use DeepSeek, or to do it yourself, follow that over the criteria below.
Follow it even when the task doesn't fit the criteria; if you have a concern, mention it in one line.

Otherwise, delegate or write it yourself, whichever costs less: "instructing + reviewing" vs "writing it yourself".

Delegate to DeepSeek when:
- The output is long and well specified (many tests, boilerplate, data conversion, code in a fixed format).
- It can be verified by tests or by running it.
- Several independent jobs can run in parallel with deepseek_batch.

Write it yourself when:
- It is a small change of a few lines.
- It needs a lot of context: relations across files, unwritten rules, decisions made in this conversation.
- Judgment is the core of it, such as design or root-cause analysis.
- Mistakes are expensive: security, data deletion, money calculations.

When delegating, pass reference files with files, save code results with output_path, and review by running tests or reading parts.
After two failed re-instructions, write it yourself.

DeepSeek's cache only hits when the start of the prompt matches an earlier request exactly.
- Put files shared across calls first in files, in the same order every time.
- When several jobs share the same files, send one first and the rest in parallel after it answers.

When you need current information or web research, use deepseek_research before searching yourself.
DeepSeek reads the search results and pages; only a summary with sources comes back.`

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
const MAX_FILE_CHARS = 200_000
// Default max_tokens for output_path calls. Reasoning tokens share this budget, so the API default (64K) cuts long code.
const FILE_MAX_TOKENS = 300_000
const REASONING_EFFORTS = ['none', 'low', 'high', 'max'] as const
// Always sent explicitly, so behavior stays the same if the API default changes
const DEFAULT_REASONING_EFFORT = 'high'
const TRUNCATED_NOTE = '[truncated] The reply hit the max_tokens limit. The end of the result is incomplete.'
const INTERRUPTED_NOTE = '[interrupted] The reply was cut off while streaming ({}). The end of the result is incomplete.'
const DISABLED_MESSAGE = '[disabled] The user has turned DeepSeek off. Handle this without DeepSeek.'
const MODEL_NOTE = 'Leave model empty (default deepseek-flash). Set it only when the user explicitly asks for another model.'
const EFFORT_NOTE = 'reasoning_effort is how much the model thinks (none = off, low, high = default, max). Empty means high.'

// ───────── Text people read: English or Korean ─────────

type Lang = 'en' | 'ko'

const UI = {
  en: {
    commandDescription: "Show this session's DeepSeek worker token usage and account balance",
    status: (calls: number, tok: string, hit: number) => `${calls} ${calls === 1 ? 'call' : 'calls'} ${tok}tok hit ${hit}%`,
    noCalls: 'No DeepSeek calls in this session yet.',
    detail: (u: Usage, hit: number) => [
      `DeepSeek usage (this session, ${u.model})`,
      `  Calls            ${u.calls}`,
      `  Total tokens     ${u.input + u.output}`,
      `  Cache hit        ${hit}%`,
      `  Cached input     ${u.hit}`,
      `  Uncached input   ${u.miss}`,
      `  Output           ${u.output} (reasoning ${u.reasoning})`,
      `  Last call        in ${u.lastIn} · out ${u.lastOut}`,
    ],
    balance: (now: string, start: string, spent: string) => `  Balance          ${now} (first seen ${start}, spent since ${spent})`,
    disabled: (file: string) => `DeepSeek is turned off (delete ${file} to turn it back on).`,
    keyOk: (bal?: string) => `Key OK${bal ? `, balance ${bal}` : ''}`,
    noKey: (file: string) =>
      `No DeepSeek API key. Set the api_key option of ${PLUGIN} in /plugin, or save the key to ${file}, readable only by you.`,
    keyFailed: (msg: string) => `Key check failed: ${msg}`,
  },
  ko: {
    commandDescription: '이 세션의 DeepSeek 워커 토큰 사용량과 계정 잔액을 자세히 보기',
    status: (calls: number, tok: string, hit: number) => `${calls}회 ${tok}tok hit ${hit}%`,
    noCalls: '이 세션에서는 아직 DeepSeek를 호출하지 않았어요.',
    detail: (u: Usage, hit: number) => [
      `DeepSeek 사용량 (이 세션, ${u.model})`,
      `  호출          ${u.calls}회`,
      `  토큰 합계     ${u.input + u.output}`,
      `  캐시 적중     ${hit}%`,
      `  캐시된 입력   ${u.hit}`,
      `  캐시 안 된 입력 ${u.miss}`,
      `  출력          ${u.output} (그중 추론 ${u.reasoning})`,
      `  마지막 호출   입력 ${u.lastIn} · 출력 ${u.lastOut}`,
    ],
    balance: (now: string, start: string, spent: string) => `  계정 잔액     ${now} (첫 조회 ${start}, 그 뒤 사용 ${spent})`,
    disabled: (file: string) => `DeepSeek는 꺼져 있어요(${file}를 지우면 다시 켜져요).`,
    keyOk: (bal?: string) => `키 정상${bal ? `, 계정 잔액 ${bal}` : ''}`,
    noKey: (file: string) =>
      `DeepSeek API 키가 없어요. /plugin 에서 ${PLUGIN}의 api_key 옵션에 넣거나, 본인만 읽을 수 있게 ${file}에 저장하세요.`,
    keyFailed: (msg: string) => `키 확인 실패: ${msg}`,
  },
} satisfies Record<Lang, unknown>

// A locale string such as ko_KR.UTF-8 or ko-KR → its language. C and POSIX say nothing.
const langOfLocale = (v: string | undefined): Lang | undefined =>
  !v || /^(C|POSIX)([.@]|$)/.test(v) ? undefined : /^ko([_.@-]|$)/i.test(v) ? 'ko' : 'en'

// The `language` option: en / ko, or auto. auto looks at LC_ALL, LC_MESSAGES and LANG, then at the
// macOS system language (apps started from the Dock usually have no LANG), and falls back to English.
async function detectLang(io: IO, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ko') return option
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const lang = langOfLocale(await io.env(name))
    if (lang) return lang
  }
  const defaults = '/usr/bin/defaults'
  if (await io.exists(defaults)) {
    let out = ''
    try {
      for await (const { stream, text } of io.spawn([defaults, 'read', '-g', 'AppleLanguages'], '')) {
        if (stream === 'stdout') out += text
      }
    } catch {
      return 'en'
    }
    // Prints a list such as ( "ko-KR", "en-US" ); the first entry is the preferred language
    const first = /\(\s*"?([A-Za-z]+[^",\s)]*)/.exec(out)?.[1]
    return langOfLocale(first) ?? 'en'
  }
  return 'en'
}

// ───────── Settings: API key, endpoint, home folder ─────────

type Config = { key: string; baseUrl: string; model: string; home: string; curl: string; workdir?: string }

async function homeDir(io: IO) {
  return ((await io.env('HOME')) || (await io.env('USERPROFILE')) || '').replace(/[\\/]+$/, '')
}

const configDir = (home: string) => `${home}/.config/deepseek`

// Use the OS's own curl by absolute path, so a fake curl planted on PATH never receives the API key
async function curlPath(io: IO) {
  const root = await io.env('SystemRoot') // only set on Windows
  const path = root ? `${root.replace(/[\\/]+$/, '')}\\System32\\curl.exe` : '/usr/bin/curl'
  if (!(await io.exists(path))) throw new Error(`curl not found: ${path}`)
  return path
}

// ───────── Path permissions: files and output_path only where Claude may Read / Write ─────────
// No path rules of our own: follow Claude Code's permission decision. So the working folder, the session's
// scratchpad and /add-dir folders work, and files the user blocked with a deny rule (say Read(.env)) never reach DeepSeek.

const isAbsolute = (p: string) => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)

// Use / as the separator and resolve . and ..
function normalize(p: string) {
  const parts: string[] = []
  const [head, ...rest] = p.replace(/\\/g, '/').split('/')
  for (const seg of rest) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `${head}/${parts.join('/')}`
}

// The real path (links followed). For a path that doesn't exist yet, resolve the nearest existing parent and append the rest
async function realDir(io: IO, path: string) {
  const tail: string[] = []
  let cur = normalize(path)
  for (;;) {
    const real = await io.realPath(cur)
    if (real !== undefined) return normalize([real, ...tail.reverse()].join('/'))
    const i = cur.lastIndexOf('/')
    if (i <= 0) return normalize(path)
    tail.push(cur.slice(i + 1))
    cur = cur.slice(0, i)
  }
}

// Returns the absolute path to read or write, or refuses with the reason.
// allow → go, deny → refuse, ask (a person would be asked) → go only inside the working folder.
// A link is asked about twice, as itself and as its real target, so a link in the working folder can't reach
// an outside file (say ~/.ssh/id_rsa) or a deny-ruled one. Both must be allow for allow.
// The plugin option allow_outside_workdir skips all of this.
async function checkedPath(io: IO, cfg: Config, p: string, mode: 'read' | 'write') {
  const expanded = expand(cfg, p)
  const abs = isAbsolute(expanded) ? expanded : `${await io.cwd()}/${expanded}`
  if (!cfg.workdir) return abs
  const real = await realDir(io, abs)
  const asked = real === normalize(abs) ? [abs] : [abs, real]
  let allAllowed = true
  for (const x of asked) {
    const verdict = await io.check(mode === 'read' ? 'Read' : 'Write', x)
    if (verdict.decision === 'deny') {
      const what = x === abs ? '' : ` (link to ${x})`
      throw new Error(`Cannot ${mode} ${p}${what}: Claude Code's permission settings block it${verdict.reason ? ` (${verdict.reason})` : ''}.`)
    }
    if (verdict.decision !== 'allow') allAllowed = false
  }
  if (allAllowed) return abs
  const windows = /^[A-Za-z]:/.test(cfg.workdir)
  const [r, w] = windows ? [real.toLowerCase(), cfg.workdir.toLowerCase()] : [real, cfg.workdir]
  if (r === w || r.startsWith(w.endsWith('/') ? w : `${w}/`)) return abs
  throw new Error(
    `Cannot ${mode} ${p}${real === normalize(abs) ? '' : ` (link to ${real})`}: it is outside the working folder (${cfg.workdir}) and Claude Code would not allow it without asking. ` +
      `Use a path in the working folder or the session scratchpad, add the folder with /add-dir, or turn on the allow_outside_workdir option of ${PLUGIN} in /plugin.`,
  )
}

// The key comes from the plugin option (secure storage), then ~/.config/deepseek/api_key.
// Never from an environment variable: every child process inherits those, and a plain `env` prints them.
class NoKeyError extends Error {
  constructor(readonly keyFile: string) {
    super(`No DeepSeek API key. Set the api_key option of ${PLUGIN} in /plugin, or save the key to ${keyFile}, readable only by you.`)
  }
}

async function findKey(io: IO, optionKey: string, home: string) {
  let key = optionKey.trim()
  const keyFile = `${configDir(home)}/api_key`
  if (!key && (await io.exists(keyFile))) key = (await io.read(keyFile)).trim()
  if (!key) throw new NoKeyError(keyFile)
  return key
}

const baseUrlOf = async (io: IO) => ((await io.env('DEEPSEEK_BASE_URL')) || DEFAULT_BASE_URL).replace(/\/+$/, '')

async function loadConfig(io: IO, optionKey: string, allowOutside: boolean): Promise<Config> {
  const home = await homeDir(io)
  return {
    key: await findKey(io, optionKey, home),
    baseUrl: await baseUrlOf(io),
    model: (await io.env('DEEPSEEK_MODEL')) || DEFAULT_MODEL,
    home,
    curl: await curlPath(io),
    workdir: allowOutside ? undefined : await realDir(io, await io.cwd()),
  }
}

// While this file exists DeepSeek is off. Delete it to turn it back on.
const disabledFile = (home: string) => `${configDir(home.replace(/[\\/]+$/, ''))}/disabled`

// ───────── API calls ─────────

async function api(io: IO, cfg: Config, path: string, body?: unknown): Promise<any> {
  const r = await io.fetch(`${cfg.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`DeepSeek API ${path} → HTTP ${r.status}: ${r.text.slice(0, 500)}`)
  return JSON.parse(r.text)
}

// A quoted string in curl's config-file syntax (the key and body go through stdin, never the command line)
const curlQuote = (s: string) =>
  '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'

function curlConfig(cfg: Config, path: string, body: unknown) {
  return [
    `url = ${curlQuote(`${cfg.baseUrl}${path}`)}`,
    `header = ${curlQuote(`Authorization: Bearer ${cfg.key}`)}`,
    `header = ${curlQuote('Content-Type: application/json')}`,
    `data-binary = ${curlQuote(JSON.stringify(body))}`,
    'silent',
    'show-error',
    'no-buffer',
  ].join('\n')
}

// Requests that may take over 30 seconds (the research steps) go through curl without streaming
async function curlJson(io: IO, cfg: Config, path: string, body: unknown): Promise<any> {
  let stdout = ''
  let stderr = ''
  for await (const { stream, text } of io.spawn([cfg.curl, '--config', '-'], curlConfig(cfg, path, body))) {
    if (stream === 'stdout') stdout += text
    else stderr += text
  }
  let data: any
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new Error(`DeepSeek API ${path} failed: ${(stdout || stderr || 'no response').trim().slice(0, 500)}`)
  }
  if (data.error) throw new Error(`DeepSeek API ${path} failed: ${JSON.stringify(data.error).slice(0, 500)}`)
  return data
}

type Streamed = { content: string; usage: any; model?: string; finish?: string; error?: string }

// Calls /chat/completions with stream: true and collects the SSE chunks. If cut off midway, returns what arrived.
async function streamChat(io: IO, cfg: Config, body: Record<string, unknown>): Promise<Streamed> {
  const req = { ...body, stream: true, stream_options: { include_usage: true } }
  const out: Streamed = { content: '', usage: undefined }
  const parts: string[] = []
  let buf = ''
  let raw = '' // the start of a non-SSE reply (an HTTP error body), kept to report it
  let stderr = ''
  let sawEvent = false
  const take = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    sawEvent = true
    let chunk: any
    try {
      chunk = JSON.parse(data)
    } catch {
      return
    }
    if (chunk.model) out.model = chunk.model
    if (chunk.usage) out.usage = chunk.usage
    for (const c of chunk.choices ?? []) {
      if (c.delta?.content) parts.push(c.delta.content)
      if (c.finish_reason) out.finish = c.finish_reason
    }
  }
  try {
    for await (const { stream, text } of io.spawn([cfg.curl, '--config', '-'], curlConfig(cfg, '/chat/completions', req))) {
      if (stream === 'stderr') {
        stderr += text
        continue
      }
      if (!sawEvent && raw.length < 4000) raw += text
      buf += text
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      lines.forEach(l => take(l.replace(/\r$/, '')))
    }
    take(buf.replace(/\r$/, ''))
  } catch (err) {
    out.error = (err as Error).message
  }
  out.content = parts.join('')
  if (!sawEvent) {
    // Not a single event arrived: a curl error, or the API answered with an error JSON
    throw new Error(`DeepSeek API /chat/completions failed: ${(raw || stderr || out.error || 'no response').trim().slice(0, 500)}`)
  }
  if (!out.finish && !out.error) out.error = stderr.trim() || 'stream closed without a finish marker'
  return out
}

type Tokens = { in: number; out: number; hit?: number; miss?: number; reasoning?: number }

function tokensOf(u: any): Tokens | undefined {
  if (!u) return undefined
  return {
    in: u.prompt_tokens ?? 0,
    out: u.completion_tokens ?? 0,
    hit: u.prompt_cache_hit_tokens ?? undefined,
    miss: u.prompt_cache_miss_tokens ?? undefined,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? undefined,
  }
}

// The usage line at the end of a result: [usage: model, in=.. out=.. hit=.. miss=.. reasoning=..]
function usageLine(model: string, t: Tokens) {
  const extra = (['hit', 'miss', 'reasoning'] as const)
    .filter(k => t[k] !== undefined)
    .map(k => ` ${k}=${t[k]}`)
    .join('')
  return `[usage: ${model}, in=${t.in} out=${t.out}${extra}]`
}

function checkEffort(effort: unknown) {
  const e = (effort as string | undefined) || DEFAULT_REASONING_EFFORT
  if (!(REASONING_EFFORTS as readonly string[]).includes(e)) {
    throw new Error(`reasoning_effort must be one of ${REASONING_EFFORTS.join(', ')}: ${JSON.stringify(effort)}`)
  }
  return e
}

const expand = (cfg: Config, p: string) => (p === '~' || p.startsWith('~/') ? cfg.home + p.slice(1) : p)

async function buildPrompt(io: IO, cfg: Config, prompt: string, files: unknown) {
  if (!Array.isArray(files) || files.length === 0) return prompt
  const parts: string[] = []
  for (const f of files as string[]) {
    let text = await io.read(await checkedPath(io, cfg, f, 'read'))
    if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS) + '\n...[truncated]'
    parts.push(`<file path="${f}">\n${text}\n</file>`)
  }
  return parts.join('\n\n') + '\n\n' + prompt
}

type Reply = { content: string; usage: Tokens | undefined; model: string; complete: boolean; notes: string[] }

async function request(io: IO, cfg: Config, a: Args, opts: { prompt: string; maxTokens?: number }): Promise<Reply> {
  const system = a.system ? `${COMMON_SYSTEM}\n\n${a.system}` : COMMON_SYSTEM
  const model = (a.model as string) || cfg.model
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: await buildPrompt(io, cfg, opts.prompt, a.files) },
    ],
    reasoning_effort: checkEffort(a.reasoning_effort),
  }
  if (a.temperature != null) body.temperature = a.temperature
  const maxTokens = (a.max_tokens as number | undefined) ?? opts.maxTokens
  if (maxTokens != null) body.max_tokens = maxTokens

  const s = await streamChat(io, cfg, body)
  const notes = s.error
    ? [INTERRUPTED_NOTE.replace('{}', s.error.slice(0, 200))]
    : s.finish === 'length'
      ? [TRUNCATED_NOTE]
      : []
  return {
    content: s.content,
    usage: tokensOf(s.usage),
    model: s.model ?? model,
    complete: notes.length === 0,
    notes,
  }
}

const tail = (r: Reply) => [...r.notes, ...(r.usage ? [usageLine(r.model, r.usage)] : [])].join('\n')

async function balanceOf(io: IO, cfg: Config): Promise<{ currency: string; total: number } | undefined> {
  try {
    const b = (await api(io, cfg, '/user/balance')).balance_infos?.[0]
    return b ? { currency: b.currency, total: Number(b.total_balance) } : undefined
  } catch {
    return undefined // a failed balance lookup never spoils the actual result
  }
}

// ───────── Saving files ─────────

async function saveOutput(io: IO, cfg: Config, content: string, outputPath: string) {
  const m = FENCE_RE.exec(content)
  if (m?.[1] !== undefined) content = m[1]
  if (!content.endsWith('\n')) content += '\n'
  const path = await checkedPath(io, cfg, outputPath, 'write')
  await io.write(path, content)
  return `saved: ${path} (${content.split('\n').length - 1} lines, ${new TextEncoder().encode(content).length} bytes)`
}

// ───────── Status line and /deepseek-usage ─────────

const EMPTY: Usage = { calls: 0, input: 0, output: 0, hit: 0, miss: 0, reasoning: 0, lastIn: 0, lastOut: 0, model: '' }
// Bump the shape tag when the fields change: values saved by an older version are dropped for the initial value
const totals = atom({ plugin: 'deepseek-worker', key: 'totals' } as const, EMPTY, { shape: 'totals-1' })
const balance = atom({ plugin: 'deepseek-worker', key: 'balance' } as const, null as Balance, { shape: 'balance-1' })
const uiLang = atom({ plugin: 'deepseek-worker', key: 'uiLang' } as const, null as UiLang, { shape: 'uiLang-1' })

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`)
const cachePct = (u: Usage) => (u.hit + u.miss > 0 ? Math.round((u.hit / (u.hit + u.miss)) * 100) : 0)
const money = (currency: string, v: number) =>
  `${currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `}${v.toFixed(2)}`

function statusText(lang: Lang, u: Usage, b: Balance) {
  if (u.calls === 0) return undefined
  // The app puts the plugin name in front, so keep it to the numbers
  const head = UI[lang].status(u.calls, fmt(u.input + u.output), cachePct(u))
  return b ? `${head} ${money(b.currency, b.now)}` : head
}

function detailText(lang: Lang, u: Usage, b: Balance) {
  const t = UI[lang]
  if (u.calls === 0) return t.noCalls
  const lines = t.detail(u, cachePct(u))
  if (b) {
    // The balance is looked up after each call, so the first one seen already has the first call's cost taken off
    lines.push(t.balance(money(b.currency, b.now), money(b.currency, b.start), money(b.currency, Math.max(0, b.start - b.now))))
  }
  return lines.join('\n')
}

type Used = { model: string; t: Tokens }

type Bal = { currency: string; total: number }

function addUsage(t: Usage, used: Used[]): Usage {
  const last = used[used.length - 1]
  if (!last) return t
  let n = { ...t, lastIn: last.t.in, lastOut: last.t.out, model: last.model }
  for (const { t: x } of used) {
    n = {
      ...n,
      calls: n.calls + 1,
      input: n.input + x.in,
      output: n.output + x.out,
      hit: n.hit + (x.hit ?? 0),
      // Without cache info, count the whole input as uncached
      miss: n.miss + (x.miss ?? (x.hit === undefined ? x.in : 0)),
      reasoning: n.reasoning + (x.reasoning ?? 0),
    }
  }
  return n
}

// If the currency changes (rare), start measuring again from that value
const nextBalance = (prev: Balance, bal: Bal): Balance =>
  prev && prev.currency === bal.currency
    ? { ...prev, now: bal.total }
    : { currency: bal.currency, start: bal.total, now: bal.total }

// /deepseek-usage before any call looks up the balance on the spot to tell whether the key works (free)
async function keyCheckText(io: IO, lang: Lang, optionKey: string) {
  const t = UI[lang]
  const home = await homeDir(io)
  if (await io.exists(disabledFile(home))) return `${t.noCalls}\n${t.disabled(disabledFile(home))}`
  try {
    const cfg = { key: await findKey(io, optionKey, home), baseUrl: await baseUrlOf(io) } as Config
    const b = (await api(io, cfg, '/user/balance')).balance_infos?.[0]
    return `${t.noCalls}\n${t.keyOk(b ? money(b.currency, Number(b.total_balance)) : undefined)}`
  } catch (err) {
    if (err instanceof NoKeyError) return `${t.noCalls}\n${t.noKey(err.keyFile)}`
    return `${t.noCalls}\n${t.keyFailed((err as Error).message)}`
  }
}

// When a call finishes: add up usage, look up the balance and append it to the result text
async function finish(io: IO, cfg: Config, text: string, used: Used[]) {
  const bal = await balanceOf(io, cfg)
  if (used.length > 0) await io.record(used, bal)
  return bal ? `${text}\n[balance: ${bal.currency} ${bal.total.toFixed(2)}]` : text
}

// ───────── Tools ─────────

async function chat(io: IO, cfg: Config, a: Args) {
  const prompt = String(a.prompt ?? '')
  const outputPath = a.output_path as string | undefined
  if (!outputPath) {
    const r = await request(io, cfg, a, { prompt })
    const t = tail(r)
    return finish(io, cfg, t ? `${r.content}\n\n${t}` : r.content, r.usage ? [{ model: r.model, t: r.usage }] : [])
  }
  await checkedPath(io, cfg, outputPath, 'write') // check the path can be written before paying for the generation
  const r = await request(io, cfg, a, { prompt: prompt + FILE_ONLY_INSTRUCTION, maxTokens: FILE_MAX_TOKENS })
  // An empty or incomplete reply must not overwrite an existing file
  let saved: string
  if (!r.content.trim()) {
    saved = `[not saved] The reply was empty, so nothing was written to ${outputPath} (existing file unchanged).`
  } else if (r.complete) {
    saved = await saveOutput(io, cfg, r.content, outputPath)
  } else {
    saved =
      (await saveOutput(io, cfg, r.content, `${outputPath}.partial`)) +
      ` — incomplete, so saved as .partial (${outputPath} unchanged).`
  }
  const t = tail(r)
  return finish(io, cfg, t ? `${saved}\n${t}` : saved, r.usage ? [{ model: r.model, t: r.usage }] : [])
}

// Concurrency: 8 if not a number, clamped to 1-16 (so not too many curl processes start at once)
const MAX_CONCURRENCY = 16
const concurrencyOf = (v: unknown) => {
  const n = Math.floor(Number(v ?? 8))
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_CONCURRENCY, n)) : 8
}

// Runs n at a time; results come back in input order
async function pool<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out = new Array<T>(jobs.length)
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++
      out[i] = await jobs[i]!()
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, worker))
  return out
}

async function batch(io: IO, cfg: Config, a: Args) {
  const prompts = (a.prompts as string[] | undefined) ?? []
  const used: Used[] = []
  const results = await pool(
    concurrencyOf(a.concurrency),
    prompts.map((p, i) => async () => {
      try {
        const r = await request(io, cfg, { ...a, files: undefined }, { prompt: String(p) })
        if (r.usage) used.push({ model: r.model, t: r.usage })
        const t = tail(r)
        return `=== #${i} ===\n${t ? `${r.content}\n\n${t}` : r.content}`
      } catch (err) {
        return `=== #${i} ===\n[error] ${(err as Error).message}` // one failure doesn't stop the rest
      }
    }),
  )
  return finish(io, cfg, results.join('\n\n'), used)
}

async function models(io: IO, cfg: Config) {
  return ((await api(io, cfg, '/models')).data ?? []).map((m: { id: string }) => m.id).join('\n')
}

// ───────── Web research: give the model DeepSeek's Search and Fetch APIs as tools and let it search repeatedly ─────────
// The same backend as DeepSeek's web chat search (https://api-docs.deepseek.com/guides/search).
// Billed separately for searches and page fetches, $0.75 per 1,000 successful requests each.

const RESEARCH_SYSTEM = `Answer the question by searching the web.
- Search with web_search; when the result summaries aren't enough, read the page with web_fetch.
- Don't stop at one search: look at the results, then rephrase or narrow the query and search again as needed. Cross-check with independent sources.
- Request independent searches (other languages, other aspects, several candidates) or several page reads together in one turn; they run in parallel.
- When recency matters, check dates and say when information is outdated.
- Answer in the language of the question, most important point first, concisely. Cite sources as [1] after each supported sentence, and end with a sources list (number. title — URL) under a heading in the answer's language.
- Say so when something couldn't be confirmed by searching.`

const RESEARCH_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Web search. Supports the operators site:, -site:, "exact phrase", lang:, after:YYYY-MM-DD and before:.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (128 characters max)' },
          count: { type: 'integer', description: 'Number of results, 1-20, default 8' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Reads the page at a URL as Markdown.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
]

const SNIPPET_CHARS = 600 // summary length per search result handed to the model
const FETCH_CHARS = 12_000 // most page text handed to the model

async function webSearch(io: IO, cfg: Config, query: string, count: number, question: string) {
  const data = await api(io, cfg, '/v1/tools/search', {
    query: query.slice(0, 128),
    count: Math.max(1, Math.min(20, count)),
    ori_question: question.slice(0, 128),
  })
  const rows = (data.results ?? []).map((x: any, i: number) => {
    const summary = String(x.summary || x.snippet || '').trim().replace(/\n/g, ' ')
    return (
      `(${i + 1}) ${x.title ?? ''}\n    ${x.url ?? ''}` +
      ` · ${x.site_name || ''} · ${x.date || 'no date'} · authority ${x.authority ?? -1}\n` +
      `    ${summary.slice(0, SNIPPET_CHARS)}`
    )
  })
  return rows.join('\n') || 'no results'
}

async function webFetch(io: IO, cfg: Config, url: string) {
  const data = await api(io, cfg, '/v1/tools/fetch', { url })
  let content = String(data.content || '')
  if (content.length > FETCH_CHARS) content = content.slice(0, FETCH_CHARS) + '\n...[rest omitted]'
  return content ? `# ${data.title ?? ''}\n\n${content}` : 'Could not fetch the page text.'
}

async function research(io: IO, cfg: Config, a: Args) {
  const question = String(a.question ?? '')
  const model = (a.model as string) || cfg.model
  const maxSearches = Math.max(1, Math.min(20, Number(a.max_searches) || 8))
  const maxFetches = Math.max(1, Math.floor(maxSearches / 2))
  if (a.output_path) await checkedPath(io, cfg, a.output_path as string, 'write')
  const messages: any[] = [
    { role: 'system', content: `${COMMON_SYSTEM}\n\n${RESEARCH_SYSTEM}` },
    { role: 'user', content: question },
  ]
  const total: Tokens = { in: 0, out: 0 }
  const trail: string[] = [] // what was searched and read, in order
  let searches = 0
  let fetches = 0
  let rounds = 0
  let respModel = model
  let answer: string | undefined

  const step = async (withTools: boolean) => {
    const body: Record<string, unknown> = { model, messages, reasoning_effort: DEFAULT_REASONING_EFFORT }
    if (withTools) body.tools = RESEARCH_TOOLS
    const resp = await curlJson(io, cfg, '/chat/completions', body)
    respModel = resp.model ?? respModel
    const t = tokensOf(resp.usage)
    if (t) {
      total.in += t.in
      total.out += t.out
      for (const k of ['hit', 'miss', 'reasoning'] as const) {
        if (t[k] !== undefined) total[k] = (total[k] ?? 0) + (t[k] as number)
      }
    }
    return resp.choices?.[0]?.message ?? {}
  }

  for (let i = 0; i < maxSearches + maxFetches + 2; i++) {
    const msg = await step(true)
    const calls: any[] = msg.tool_calls ?? []
    if (calls.length === 0) {
      answer = msg.content ?? ''
      break
    }
    const turn: Record<string, unknown> = { role: 'assistant', content: msg.content ?? '', tool_calls: calls }
    // A thinking model must get its own reasoning back while tool calls continue
    if (msg.reasoning_content) turn.reasoning_content = msg.reasoning_content
    messages.push(turn)
    // Tool calls from one turn run in parallel. Limits and the trail are decided first, in order,
    // and results go back in call order (the Search and Fetch APIs allow 5 requests per second per endpoint, so 4 at a time)
    rounds++
    const jobs = calls.map((c): (() => Promise<string>) => {
      let args: any = {}
      try {
        args = JSON.parse(c.function?.arguments || '{}')
      } catch {}
      const name = c.function?.name
      if (name === 'web_search') {
        if (searches >= maxSearches) return async () => 'Search limit reached. Answer with what you have found so far.'
        searches++
        const q = String(args.query ?? '')
        trail.push(`[${rounds}] search: ${q}`)
        return () => webSearch(io, cfg, q, Number(args.count) || 8, question)
      }
      if (name === 'web_fetch') {
        if (fetches >= maxFetches) return async () => 'Page read limit reached. Answer with what you have found so far.'
        fetches++
        const u = String(args.url ?? '')
        trail.push(`[${rounds}] fetch: ${u}`)
        return () => webFetch(io, cfg, u)
      }
      return async () => `Unknown tool: ${name}`
    })
    const outs = await pool(
      4,
      jobs.map(job => async () => {
        try {
          return await job()
        } catch (err) {
          return `[tool error] ${(err as Error).message}` // one failed search doesn't stop the research
        }
      }),
    )
    calls.forEach((c, k) => messages.push({ role: 'tool', tool_call_id: c.id, content: outs[k] }))
  }
  if (answer === undefined) {
    // Out of steps: answer without tools from what was found
    messages.push({ role: 'user', content: 'Stop searching and answer with what you have found so far.' })
    answer = (await step(false)).content ?? ''
  }

  const trace = `[research: searches=${searches} fetches=${fetches} rounds=${rounds}]\n` + trail.map(t => `- ${t}`).join('\n')
  const usage = usageLine(respModel, total)
  // However many steps it took, usage counts it as one call
  const used = [{ model: respModel, t: total }]
  const outputPath = a.output_path as string | undefined
  if (outputPath) {
    const saved = await saveOutput(io, cfg, answer ?? '', outputPath)
    return finish(io, cfg, `${saved}\n${trace}\n${usage}`, used)
  }
  return finish(io, cfg, `${answer}\n\n${trace}\n${usage}`, used)
}

// ───────── Tool registration ─────────

const COMMON_PROPS = {
  system: { type: 'string', description: 'Extra system instructions appended after the default worker instructions' },
  model: { type: 'string', description: MODEL_NOTE },
  temperature: { type: 'number' },
  max_tokens: { type: 'integer' },
  reasoning_effort: { type: 'string', enum: [...REASONING_EFFORTS], description: EFFORT_NOTE },
}

type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (io: IO, cfg: Config, a: Args) => Promise<string>
}

const TOOLS: ToolDef[] = [
  {
    name: 'deepseek_chat',
    description: `Hands one task to DeepSeek and returns the result text.

files: local file paths; the tool reads them itself and puts them before the prompt (no need to copy file contents into arguments).
output_path: saves the reply straight to that file (overwriting) and returns only the path and line count.
Use it for long outputs such as code generation, so the full result never enters the caller's context.
Then test the saved file or read parts of it as needed.
With output_path, max_tokens defaults to 300000 (reasoning tokens share this budget).
If the reply is truncated, a [truncated] line is added and it is saved to <output_path>.partial instead (the existing file is unchanged).
If the reply is empty, no file is written.
${EFFORT_NOTE}
${MODEL_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        ...COMMON_PROPS,
        files: { type: 'array', items: { type: 'string' } },
        output_path: { type: 'string' },
      },
      required: ['prompt'],
    },
    run: chat,
  },
  {
    name: 'deepseek_batch',
    description: `Sends several prompts to DeepSeek in parallel and returns the results in order.

${EFFORT_NOTE}
${MODEL_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        prompts: { type: 'array', items: { type: 'string' } },
        ...COMMON_PROPS,
        concurrency: { type: 'integer', default: 8, minimum: 1, maximum: MAX_CONCURRENCY },
      },
      required: ['prompts'],
    },
    run: batch,
  },
  {
    name: 'deepseek_research',
    description: `DeepSeek searches and reads the web on its own, several times, and returns only a summary with sources.

Uses the same Search and Fetch API as DeepSeek's web chat. Use it for questions that need the web:
current information, checking docs, comparisons. Search results and page text never enter the caller's context.
The result ends with the search trail (queries, URLs read) and usage.
max_searches: search limit (1-20, default 8). Page reads up to half of that.
output_path: saves the answer to that file and returns only the path.
${MODEL_NOTE}
Cost: $0.75 per 1,000 successful searches and per 1,000 page reads, plus tokens.`,
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        model: { type: 'string', description: MODEL_NOTE },
        max_searches: { type: 'integer', default: 8 },
        output_path: { type: 'string' },
      },
      required: ['question'],
    },
    run: research,
  },
  {
    name: 'deepseek_models',
    description: 'Lists the available DeepSeek models.',
    inputSchema: { type: 'object', properties: {} },
    run: (io, cfg) => models(io, cfg),
  },
]

// Bundles the parts of the engine ($) the tool code uses
function makeIO($: EngineInterface, langOption: unknown): IO {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    realPath: path =>
      $.fs.stat(path, { resolve: true }).then(
        st => st.realPath ?? path,
        () => undefined,
      ),
    cwd: () => $.session.cwd(),
    check: (tool, filePath) =>
      $.tool.check({ tool, input: tool === 'Write' ? { file_path: filePath, content: '' } : { file_path: filePath } }),
    spawn: (argv, input) => $.process.spawn({ argv, input }),
    env: async name => {
      switch (name) {
        case 'HOME':
          return $.env.get('HOME')
        case 'USERPROFILE':
          return $.env.get('USERPROFILE')
        case 'SystemRoot':
          return $.env.get('SystemRoot')
        case 'DEEPSEEK_BASE_URL':
          return $.env.get('DEEPSEEK_BASE_URL')
        case 'DEEPSEEK_MODEL':
          return $.env.get('DEEPSEEK_MODEL')
        case 'LC_ALL':
          return $.env.get('LC_ALL')
        case 'LC_MESSAGES':
          return $.env.get('LC_MESSAGES')
        case 'LANG':
          return $.env.get('LANG')
      }
    },
    record: async (used, bal) => {
      const u = await update($, totals, prev => addUsage(prev, used))
      const b = bal ? await update($, balance, prev => nextBalance(prev, bal)) : await read($, balance)
      $.ui.status(statusText(await langOf($, langOption), u, b))
    },
  }
}

// The language people read. Detected once per session (detection may start a process) and kept in $.state;
// detected again when the `language` option changes
async function langOf($: EngineInterface, option: unknown): Promise<Lang> {
  const key = String(option ?? 'auto')
  const saved = await read($, uiLang)
  if (saved && saved.option === key) return saved.lang
  const lang = await detectLang(makeIO($, option), option)
  await update($, uiLang, () => ({ option: key, lang }))
  return lang
}

export const register: Register = (on, options) => {
  const optionKey = String(options.api_key ?? '')
  const allowOutside = options.allow_outside_workdir === true
  const langOption = options.language

  on('session.start', async ($, e, next) => {
    const lang = await langOf($, langOption)
    try {
      await $.command.register({ name: 'deepseek-usage', description: UI[lang].commandDescription })
    } catch {
      // Another plugin (such as the old deepseek-usage mod) already registered the name; skip just the command
    }
    // With ~/.config/deepseek/disabled present, don't register the tools at all
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    if (!(await $.fs.exists(disabledFile(home)))) {
      for (const t of TOOLS) await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema })
    }
    // Totals survive a reload in $.state, so restore the status line
    $.ui.status(statusText(lang, await read($, totals), await read($, balance)))
    return next(e)
  })

  // Tells Claude when to delegate and when to do it itself
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    if (await $.fs.exists(disabledFile(home))) return r
    return { sections: [...r.sections, { id: `${PLUGIN}:guide`, text: GUIDE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'deepseek-usage' }, async $ => {
    const lang = await langOf($, langOption)
    const u = await read($, totals)
    if (u.calls === 0) return { text: await keyCheckText(makeIO($, langOption), lang, optionKey) }
    return { text: detailText(lang, u, await read($, balance)) }
  })

  on('tool.call', { tool: /^mcp__deepseek-worker__deepseek_(chat|batch|research|models)$/ }, async ($, e) => {
    const t = TOOLS.find(x => TOOL(x.name) === e.tool)
    if (!t) return { deny: `Unknown tool: ${e.tool}` }
    const io = makeIO($, langOption)
    try {
      if (await io.exists(disabledFile(await homeDir(io)))) return { result: DISABLED_MESSAGE }
      const cfg = await loadConfig(io, optionKey, allowOutside)
      return { result: await t.run(io, cfg, { ...(e as object) } as Args) }
    } catch (err) {
      return { deny: `${t.name} failed: ${(err as Error).message}` }
    }
  })
}
