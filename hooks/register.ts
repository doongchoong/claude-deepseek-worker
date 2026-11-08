import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit, Register } from 'claude-code'

import type { Balance, Usage } from '../types'

// DeepSeek를 Claude의 워커로 쓰는 도구 네 개와 사용량 상태 줄.
// 별도 서버 없이 Claude Code 안에서 돈다: 파일은 $.fs, 짧은 API 호출은 $.http로 닿는다.
// $.http.fetch는 30초 안에 끝나야 해서, 시간이 걸리는 생성은 curl을 띄워 스트리밍으로 받는다
// (curl은 macOS, Linux, Windows 10 이상에 기본으로 들어 있다).

type Args = Record<string, unknown>
type EnvName = 'HOME' | 'USERPROFILE' | 'SystemRoot' | 'DEEPSEEK_BASE_URL' | 'DEEPSEEK_MODEL'

// 엔진($)은 훅 안에서만 쓸 수 있어서, 도구 구현에는 필요한 기능만 묶어 넘긴다
type IO = {
  fetch: (url: string, init: HttpInit) => Promise<{ status: number; ok: boolean; text: string }>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  // 링크를 따라간 실제 경로. 없는 경로면 undefined
  realPath: (path: string) => Promise<string | undefined>
  cwd: () => Promise<string>
  env: (name: EnvName) => Promise<string | undefined>
  // 명령을 띄워 출력을 조각조각 받는다 (input은 표준 입력으로 들어간다)
  spawn: (argv: string[], input: string) => AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>
  record: (used: Used[], bal: Bal | undefined) => Promise<void>
}

const PLUGIN = 'deepseek-worker'
const TOOL = (name: string) => `mcp__${PLUGIN}__${name}`

// 모든 요청에 기본으로 들어가는 지시. 호출 시 system을 주면 이 뒤에 덧붙는다.
const COMMON_SYSTEM = `너는 상위 에이전트(Claude)가 맡긴 작업 하나를 처리하는 워커다. 결과는 사람이 아니라 에이전트가 읽고 검토한다.
- 인사말, 서론, 맺음말, 요청하지 않은 요약 없이 요청한 결과만 출력한다.
- 정보가 부족하면 지어내지 말고, 어떤 가정을 했는지 결과 끝에 짧게 밝힌다.
- 요청받은 범위만 처리한다. 요청하지 않은 수정, 기능 추가, 내용 확장은 하지 않는다.`
const FILE_ONLY_INSTRUCTION =
  '\n\n응답 전체가 그대로 파일에 저장된다. 파일 내용만 출력하고 설명이나 코드 펜스(```)는 붙이지 말 것.' +
  ' 가정은 따로 적지 말고 가장 합리적인 쪽을 택할 것.'
const FENCE_RE = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/

// Claude에게 주는 사용 지침 (시스템 프롬프트의 한 절)
const GUIDE = `# DeepSeek 워커 (deepseek_chat · deepseek_batch · deepseek_research)
사용자가 DeepSeek를 쓰라고 하거나 직접 하라고 명시하면 아래 기준보다 그 요청을 따른다.
기준상 맞지 않는 작업이라도 따르되, 우려가 있으면 한 줄로만 알린다.

사용자 지정이 없으면 DeepSeek에 맡길지, 직접 짤지는 "지시+검수 비용"과 "직접 작성 비용" 중 작은 쪽으로 정한다.

DeepSeek에 맡길 때:
- 결과물이 길고 명세가 분명하다 (테스트 대량 작성, 보일러플레이트, 데이터 변환, 정해진 형식의 코드).
- 테스트나 실행 결과로 검증할 수 있다.
- 서로 독립된 작업 여러 개를 deepseek_batch로 병렬 처리할 수 있다.

직접 짤 때:
- 몇 줄짜리 작은 수정이다.
- 여러 파일의 관계, 숨은 규칙, 대화 중 내린 결정 등 맥락이 많이 필요하다.
- 설계나 원인 분석 같은 판단이 핵심이다.
- 보안, 데이터 삭제, 돈 계산처럼 틀리면 비싼 코드다.

맡길 때는 참고 파일은 files로 넘기고, 코드 결과는 output_path로 저장해 테스트나 일부 읽기로 검수한다.
재지시가 두 번을 넘기면 직접 짠다.

DeepSeek 캐시는 프롬프트 앞부분이 이전 요청과 똑같을 때만 맞는다.
- 여러 호출에 공통인 파일은 files 앞쪽에 매번 같은 순서로 넣는다.
- 같은 공통 파일로 여러 작업을 맡길 때는 하나를 먼저 보내고, 응답이 오면 나머지를 병렬로 보낸다.

최신 정보나 웹 조사가 필요하면 직접 검색하기 전에 deepseek_research를 먼저 쓴다.
검색 결과와 페이지 본문은 DeepSeek 쪽에서 읽고, 출처가 달린 정리만 돌아온다.`

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
const MAX_FILE_CHARS = 200_000
// output_path 호출의 기본 max_tokens. 사고 토큰도 이 예산을 함께 쓰므로 API 기본(64K)으로는 긴 코드가 잘린다.
const FILE_MAX_TOKENS = 300_000
const REASONING_EFFORTS = ['none', 'low', 'high', 'max'] as const
// API 기본값에 맡기지 않고 매번 명시해 보낸다. API 기본이 바뀌어도 동작이 그대로이도록.
const DEFAULT_REASONING_EFFORT = 'high'
const TRUNCATED_NOTE = '[truncated] 응답이 max_tokens 한도에서 잘렸다. 결과 끝이 미완성이다.'
const INTERRUPTED_NOTE = '[interrupted] 응답을 받는 중 끊겼다({}). 결과 끝이 미완성이다.'
const DISABLED_MESSAGE = '[disabled] 사용자가 DeepSeek를 꺼 두었다. DeepSeek 없이 직접 처리할 것.'
const MODEL_NOTE = 'model은 비워 둘 것(기본 deepseek-flash). 사용자가 다른 모델을 명시적으로 요청한 경우에만 지정한다.'
const EFFORT_NOTE = 'reasoning_effort는 사고량이다(none=사고 끔, low, high=기본, max). 비워 두면 high.'

// ───────── 설정: API 키, 주소, 홈 폴더 ─────────

type Config = { key: string; baseUrl: string; model: string; home: string; curl: string; workdir?: string }

async function homeDir(io: IO) {
  return ((await io.env('HOME')) || (await io.env('USERPROFILE')) || '').replace(/[\\/]+$/, '')
}

const configDir = (home: string) => `${home}/.config/deepseek`

// PATH에 심어 둔 가짜 curl이 API 키를 받지 않도록 OS에 들어 있는 curl을 절대 경로로 쓴다
async function curlPath(io: IO) {
  const root = await io.env('SystemRoot') // Windows에만 있다
  const path = root ? `${root.replace(/[\\/]+$/, '')}\\System32\\curl.exe` : '/usr/bin/curl'
  if (!(await io.exists(path))) throw new Error(`curl을 찾지 못했습니다: ${path}`)
  return path
}

// ───────── 작업 폴더 제한: files와 output_path는 세션의 작업 폴더 안에서만 읽고 쓴다 ─────────

const isAbsolute = (p: string) => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)

// 구분자를 /로 맞추고 . 과 .. 을 푼다
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

// 실제 경로(링크를 따라간 것). 아직 없는 경로면 있는 상위 폴더까지 올라가 실제 경로를 구하고 나머지를 붙인다
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

// 작업 폴더 밖이면 거절한다 (플러그인 옵션 allow_outside_workdir로 끌 수 있다). 읽고 쓸 절대 경로를 돌려준다
async function checkedPath(io: IO, cfg: Config, p: string) {
  const expanded = expand(cfg, p)
  const abs = isAbsolute(expanded) ? expanded : `${await io.cwd()}/${expanded}`
  if (!cfg.workdir) return abs
  const real = await realDir(io, abs)
  const windows = /^[A-Za-z]:/.test(cfg.workdir)
  const [r, w] = windows ? [real.toLowerCase(), cfg.workdir.toLowerCase()] : [real, cfg.workdir]
  if (r === w || r.startsWith(w.endsWith('/') ? w : `${w}/`)) return abs
  throw new Error(
    `${p}는 작업 폴더(${cfg.workdir}) 밖이라 읽거나 쓸 수 없습니다. 작업 폴더 안 경로를 쓰거나, /plugin 에서 ${PLUGIN}의 allow_outside_workdir 옵션을 켜세요.`,
  )
}

// 키는 플러그인 옵션(보안 저장소) → ~/.config/deepseek/api_key 순서로 찾는다.
// 환경변수는 모든 자식 프로세스에 물려주고 env로 쉽게 드러나므로 키를 받지 않는다
async function findKey(io: IO, optionKey: string, home: string) {
  let key = optionKey.trim()
  const keyFile = `${configDir(home)}/api_key`
  if (!key && (await io.exists(keyFile))) key = (await io.read(keyFile)).trim()
  if (!key) {
    throw new Error(
      `DeepSeek API 키가 없습니다. /plugin 에서 ${PLUGIN} 옵션(api_key)에 넣거나, 본인만 읽을 수 있게 ${keyFile}에 저장하세요.`,
    )
  }
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

// 이 파일이 있으면 DeepSeek를 끈 것으로 본다. 지우면 다시 켜진다.
const disabledFile = (home: string) => `${configDir(home.replace(/[\\/]+$/, ''))}/disabled`

// ───────── API 호출 ─────────

async function api(io: IO, cfg: Config, path: string, body?: unknown): Promise<any> {
  const r = await io.fetch(`${cfg.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`DeepSeek API ${path} → HTTP ${r.status}: ${r.text.slice(0, 500)}`)
  return JSON.parse(r.text)
}

// curl 설정 파일 문법의 따옴표 문자열 (키와 본문이 명령줄에 드러나지 않게 표준 입력으로 넘긴다)
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

// 30초를 넘길 수 있는 요청(조사 단계의 생성)은 스트리밍 없이 curl로 받는다
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
    throw new Error(`DeepSeek API ${path} 실패: ${(stdout || stderr || '응답 없음').trim().slice(0, 500)}`)
  }
  if (data.error) throw new Error(`DeepSeek API ${path} 실패: ${JSON.stringify(data.error).slice(0, 500)}`)
  return data
}

type Streamed = { content: string; usage: any; model?: string; finish?: string; error?: string }

// /chat/completions를 stream: true로 부르고 SSE 조각을 모은다. 도중에 끊겨도 받은 데까지는 돌려준다.
async function streamChat(io: IO, cfg: Config, body: Record<string, unknown>): Promise<Streamed> {
  const req = { ...body, stream: true, stream_options: { include_usage: true } }
  const out: Streamed = { content: '', usage: undefined }
  const parts: string[] = []
  let buf = ''
  let raw = '' // SSE가 아닌 응답(HTTP 오류 본문)을 알아보려고 앞부분만 모아 둔다
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
    // 스트림이 하나도 오지 않았다: curl 오류이거나 API가 오류 JSON을 돌려줬다
    throw new Error(`DeepSeek API /chat/completions 실패: ${(raw || stderr || out.error || '응답 없음').trim().slice(0, 500)}`)
  }
  if (!out.finish && !out.error) out.error = stderr.trim() || '스트림이 끝 표시 없이 닫혔다'
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

// 결과 끝에 붙는 사용량 줄: [usage: 모델, in=.. out=.. hit=.. miss=.. reasoning=..]
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
    throw new Error(`reasoning_effort는 ${REASONING_EFFORTS.join(', ')} 중 하나여야 합니다: ${JSON.stringify(effort)}`)
  }
  return e
}

const expand = (cfg: Config, p: string) => (p === '~' || p.startsWith('~/') ? cfg.home + p.slice(1) : p)

async function buildPrompt(io: IO, cfg: Config, prompt: string, files: unknown) {
  if (!Array.isArray(files) || files.length === 0) return prompt
  const parts: string[] = []
  for (const f of files as string[]) {
    let text = await io.read(await checkedPath(io, cfg, f))
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
    return undefined // 잔액 조회가 실패해도 본 작업 결과는 그대로 돌려준다
  }
}

// ───────── 파일 저장 ─────────

async function saveOutput(io: IO, cfg: Config, content: string, outputPath: string) {
  const m = FENCE_RE.exec(content)
  if (m?.[1] !== undefined) content = m[1]
  if (!content.endsWith('\n')) content += '\n'
  const path = await checkedPath(io, cfg, outputPath)
  await io.write(path, content)
  return `saved: ${path} (${content.split('\n').length - 1} lines, ${new TextEncoder().encode(content).length} bytes)`
}

// ───────── 상태 줄과 /deepseek-usage ─────────

const EMPTY: Usage = { calls: 0, input: 0, output: 0, hit: 0, miss: 0, reasoning: 0, lastIn: 0, lastOut: 0, model: '' }
// 필드를 바꾸면 태그를 올린다: 예전 버전이 저장한 값은 버리고 초기값으로 시작한다
const totals = atom({ plugin: 'deepseek-worker', key: 'totals' } as const, EMPTY, { shape: 'totals-1' })
const balance = atom({ plugin: 'deepseek-worker', key: 'balance' } as const, null as Balance, { shape: 'balance-1' })

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`)
const cachePct = (u: Usage) => (u.hit + u.miss > 0 ? Math.round((u.hit / (u.hit + u.miss)) * 100) : 0)
const money = (currency: string, v: number) =>
  `${currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `}${v.toFixed(2)}`

function statusText(u: Usage, b: Balance) {
  if (u.calls === 0) return undefined
  // 앱이 앞에 mod 이름을 붙여 주므로 숫자만 짧게
  const head = `${u.calls}회 ${fmt(u.input + u.output)}tok hit ${cachePct(u)}%`
  return b ? `${head} ${money(b.currency, b.now)}` : head
}

function detailText(u: Usage, b: Balance) {
  if (u.calls === 0) return '이 세션에서는 아직 DeepSeek를 호출하지 않았어요.'
  const lines = [
    `DeepSeek 사용량 (이 세션, ${u.model})`,
    `  호출          ${u.calls}회`,
    `  토큰 합계     ${u.input + u.output}`,
    `  캐시 적중     ${cachePct(u)}%`,
    `  캐시된 입력   ${u.hit}`,
    `  캐시 안 된 입력 ${u.miss}`,
    `  출력          ${u.output} (그중 추론 ${u.reasoning})`,
    `  마지막 호출   입력 ${u.lastIn} · 출력 ${u.lastOut}`,
  ]
  if (b) {
    // 잔액은 호출이 끝난 뒤에 조회하므로, 세션에서 처음 본 잔액엔 첫 호출 비용이 이미 빠져 있다
    lines.push(
      `  계정 잔액     ${money(b.currency, b.now)} (첫 조회 ${money(b.currency, b.start)}, 그 뒤 사용 ${money(b.currency, Math.max(0, b.start - b.now))})`,
    )
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
      // 캐시 정보가 없으면 입력 전체를 캐시 안 된 것으로 센다
      miss: n.miss + (x.miss ?? (x.hit === undefined ? x.in : 0)),
      reasoning: n.reasoning + (x.reasoning ?? 0),
    }
  }
  return n
}

// 통화가 바뀌면(드묾) 그 값부터 다시 잰다
const nextBalance = (prev: Balance, bal: Bal): Balance =>
  prev && prev.currency === bal.currency
    ? { ...prev, now: bal.total }
    : { currency: bal.currency, start: bal.total, now: bal.total }

// /deepseek-usage를 호출 전에 쓰면 그 자리에서 잔액을 조회해 키가 맞는지 알려 준다 (잔액 조회는 무료)
async function keyCheckText(io: IO, optionKey: string) {
  const head = '이 세션에서는 아직 DeepSeek를 호출하지 않았어요.'
  const home = await homeDir(io)
  if (await io.exists(disabledFile(home))) return `${head}\nDeepSeek는 꺼져 있어요(${disabledFile(home)}를 지우면 다시 켜져요).`
  try {
    const cfg = { key: await findKey(io, optionKey, home), baseUrl: await baseUrlOf(io) } as Config
    const b = (await api(io, cfg, '/user/balance')).balance_infos?.[0]
    return `${head}\n키 정상${b ? `, 계정 잔액 ${money(b.currency, Number(b.total_balance))}` : ''}`
  } catch (err) {
    return `${head}\n키 확인 실패: ${(err as Error).message}`
  }
}

// 호출 하나가 끝나면 사용량을 더하고, 잔액을 조회해 결과 텍스트 끝에 붙인다
async function finish(io: IO, cfg: Config, text: string, used: Used[]) {
  const bal = await balanceOf(io, cfg)
  if (used.length > 0) await io.record(used, bal)
  return bal ? `${text}\n[balance: ${bal.currency} ${bal.total.toFixed(2)}]` : text
}

// ───────── 도구 ─────────

async function chat(io: IO, cfg: Config, a: Args) {
  const prompt = String(a.prompt ?? '')
  const outputPath = a.output_path as string | undefined
  if (!outputPath) {
    const r = await request(io, cfg, a, { prompt })
    const t = tail(r)
    return finish(io, cfg, t ? `${r.content}\n\n${t}` : r.content, r.usage ? [{ model: r.model, t: r.usage }] : [])
  }
  await checkedPath(io, cfg, outputPath) // 생성 비용을 쓰기 전에 저장할 수 있는 경로인지 먼저 본다
  const r = await request(io, cfg, a, { prompt: prompt + FILE_ONLY_INSTRUCTION, maxTokens: FILE_MAX_TOKENS })
  // 빈 응답이나 미완성 응답이 기존 파일을 덮어쓰지 않도록 한다
  let saved: string
  if (!r.content.trim()) {
    saved = `[not saved] 응답 본문이 비어 있어 ${outputPath}에 쓰지 않았다(기존 파일 그대로).`
  } else if (r.complete) {
    saved = await saveOutput(io, cfg, r.content, outputPath)
  } else {
    saved =
      (await saveOutput(io, cfg, r.content, `${outputPath}.partial`)) +
      ` — 미완성이라 .partial로 저장했다(${outputPath}는 그대로).`
  }
  const t = tail(r)
  return finish(io, cfg, t ? `${saved}\n${t}` : saved, r.usage ? [{ model: r.model, t: r.usage }] : [])
}

// 동시 실행 수: 숫자가 아니면 기본 8, 1~16으로 자른다 (curl 프로세스가 한꺼번에 너무 많이 뜨지 않게)
const MAX_CONCURRENCY = 16
const concurrencyOf = (v: unknown) => {
  const n = Math.floor(Number(v ?? 8))
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_CONCURRENCY, n)) : 8
}

// n개씩 동시에 실행하고 결과는 입력 순서대로
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
        return `=== #${i} ===\n[error] ${(err as Error).message}` // 한 건 실패가 전체를 막지 않도록
      }
    }),
  )
  return finish(io, cfg, results.join('\n\n'), used)
}

async function models(io: IO, cfg: Config) {
  return ((await api(io, cfg, '/models')).data ?? []).map((m: { id: string }) => m.id).join('\n')
}

// ───────── 웹 조사: DeepSeek Search·Fetch API를 도구로 주고 모델이 스스로 검색을 반복한다 ─────────
// DeepSeek 웹챗의 검색과 같은 백엔드다 (https://api-docs.deepseek.com/guides/search).
// 성공한 요청 1,000건당 0.75달러씩, 검색과 페이지 읽기가 따로 과금된다.

const RESEARCH_SYSTEM = `웹을 검색해 질문에 답한다.
- web_search로 검색하고, 결과 요약만으로 부족하면 web_fetch로 페이지 본문을 읽는다.
- 한 번에 끝내지 말고, 결과를 보고 검색어를 바꾸거나 좁혀 필요한 만큼 다시 검색한다. 서로 다른 출처로 교차 확인한다.
- 서로 독립적인 검색(다른 언어, 다른 측면, 여러 후보)이나 여러 페이지 읽기는 한 번에 같이 요청한다. 동시에 실행되어 빠르다.
- 최신 정보가 중요한 질문이면 날짜를 확인하고, 오래된 정보는 오래됐다고 밝힌다.
- 답은 질문과 같은 언어로, 핵심부터 간결하게 쓴다. 근거가 된 문장마다 [1]처럼 출처 번호를 붙이고, 끝에 "출처" 목록(번호. 제목 — URL)을 단다.
- 검색으로 확인하지 못한 내용은 확인하지 못했다고 쓴다.`

const RESEARCH_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '웹 검색. site:, -site:, "정확한 구", lang:, after:YYYY-MM-DD, before: 연산자를 쓸 수 있다.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '검색어 (128자 이내)' },
          count: { type: 'integer', description: '결과 수 1~20, 기본 8' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'URL의 페이지 본문을 마크다운으로 읽는다.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
]

const SNIPPET_CHARS = 600 // 검색 결과 하나당 모델에게 넘기는 요약 길이
const FETCH_CHARS = 12_000 // 페이지 본문을 넘기는 최대 길이

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
      ` · ${x.site_name || ''} · ${x.date || '날짜 없음'} · 신뢰도 ${x.authority ?? -1}\n` +
      `    ${summary.slice(0, SNIPPET_CHARS)}`
    )
  })
  return rows.join('\n') || '결과 없음'
}

async function webFetch(io: IO, cfg: Config, url: string) {
  const data = await api(io, cfg, '/v1/tools/fetch', { url })
  let content = String(data.content || '')
  if (content.length > FETCH_CHARS) content = content.slice(0, FETCH_CHARS) + '\n...[이하 생략]'
  return content ? `# ${data.title ?? ''}\n\n${content}` : '본문을 가져오지 못했다.'
}

async function research(io: IO, cfg: Config, a: Args) {
  const question = String(a.question ?? '')
  const model = (a.model as string) || cfg.model
  const maxSearches = Math.max(1, Math.min(20, Number(a.max_searches) || 8))
  const maxFetches = Math.max(1, Math.floor(maxSearches / 2))
  if (a.output_path) await checkedPath(io, cfg, a.output_path as string)
  const messages: any[] = [
    { role: 'system', content: `${COMMON_SYSTEM}\n\n${RESEARCH_SYSTEM}` },
    { role: 'user', content: question },
  ]
  const total: Tokens = { in: 0, out: 0 }
  const trail: string[] = [] // 검색 과정: 무엇을 검색하고 읽었는지 남긴다
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
    // 생각하는 모델은 도구 호출이 이어지는 동안 자기 추론을 다시 받아야 한다
    if (msg.reasoning_content) turn.reasoning_content = msg.reasoning_content
    messages.push(turn)
    // 한 턴에 나온 도구 호출들은 동시에 실행한다. 한도 판단과 검색 과정 기록은 순서대로 먼저 하고,
    // 결과는 호출 순서대로 돌려준다 (Search·Fetch API는 엔드포인트당 초당 5회 제한이라 4개씩)
    rounds++
    const jobs = calls.map((c): (() => Promise<string>) => {
      let args: any = {}
      try {
        args = JSON.parse(c.function?.arguments || '{}')
      } catch {}
      const name = c.function?.name
      if (name === 'web_search') {
        if (searches >= maxSearches) return async () => '검색 한도에 도달했다. 지금까지 찾은 내용으로 답하라.'
        searches++
        const q = String(args.query ?? '')
        trail.push(`[${rounds}] 검색: ${q}`)
        return () => webSearch(io, cfg, q, Number(args.count) || 8, question)
      }
      if (name === 'web_fetch') {
        if (fetches >= maxFetches) return async () => '페이지 읽기 한도에 도달했다. 지금까지 찾은 내용으로 답하라.'
        fetches++
        const u = String(args.url ?? '')
        trail.push(`[${rounds}] 읽기: ${u}`)
        return () => webFetch(io, cfg, u)
      }
      return async () => `알 수 없는 도구: ${name}`
    })
    const outs = await pool(
      4,
      jobs.map(job => async () => {
        try {
          return await job()
        } catch (err) {
          return `[도구 오류] ${(err as Error).message}` // 검색 하나가 실패해도 조사는 이어간다
        }
      }),
    )
    calls.forEach((c, k) => messages.push({ role: 'tool', tool_call_id: c.id, content: outs[k] }))
  }
  if (answer === undefined) {
    // 단계 한도를 다 쓰면 도구 없이 지금까지로 답하게 한다
    messages.push({ role: 'user', content: '검색을 멈추고 지금까지 찾은 내용으로 답하라.' })
    answer = (await step(false)).content ?? ''
  }

  const trace = `[research: searches=${searches} fetches=${fetches} rounds=${rounds}]\n` + trail.map(t => `- ${t}`).join('\n')
  const usage = usageLine(respModel, total)
  // 단계가 여러 번이어도 사용량에서는 호출 1회로 센다
  const used = [{ model: respModel, t: total }]
  const outputPath = a.output_path as string | undefined
  if (outputPath) {
    const saved = await saveOutput(io, cfg, answer ?? '', outputPath)
    return finish(io, cfg, `${saved}\n${trace}\n${usage}`, used)
  }
  return finish(io, cfg, `${answer}\n\n${trace}\n${usage}`, used)
}

// ───────── 도구 등록 ─────────

const COMMON_PROPS = {
  system: { type: 'string', description: '기본 워커 지시 뒤에 덧붙일 system 지시' },
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
    description: `DeepSeek에 작업 하나를 맡기고 결과 텍스트를 받는다.

files에 로컬 파일 경로를 주면 직접 읽어 프롬프트 앞에 붙인다(호출하는 쪽이 파일 내용을 인자로 옮길 필요가 없다).
output_path를 주면 응답을 그 파일에 바로 저장하고(덮어씀) 경로·줄 수만 돌려준다.
코드 생성처럼 결과가 긴 작업에 쓰면 결과 전문이 호출하는 쪽 컨텍스트로 오지 않는다.
필요하면 저장된 파일을 테스트하거나 일부만 읽어 확인할 것.
output_path가 있으면 max_tokens 기본값은 300000이다(사고 토큰도 이 예산을 쓴다).
응답이 잘리면 [truncated] 줄이 붙고 output_path 대신 <output_path>.partial에 저장한다(기존 파일은 그대로).
본문이 비면 아무 파일도 쓰지 않는다.
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
    description: `여러 프롬프트를 DeepSeek에 병렬로 보내고 결과를 순서대로 돌려준다.

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
    description: `DeepSeek가 웹을 스스로 여러 번 검색·열람해 질문에 답하고, 출처가 달린 정리만 돌려준다.

DeepSeek 웹챗과 같은 Search·Fetch API를 쓴다. 최신 정보, 문서 확인, 비교 조사처럼
웹 검색이 필요한 질문에 쓴다. 검색 결과와 페이지 본문은 호출하는 쪽 컨텍스트로 오지 않는다.
결과 끝에 검색 과정(검색어, 읽은 URL)과 사용량이 붙는다.
max_searches: 검색 횟수 한도(1~20, 기본 8). 페이지 읽기는 그 절반까지.
output_path를 주면 답을 그 파일에 저장하고 경로만 돌려준다.
${MODEL_NOTE}
비용: 검색·읽기 각각 성공 1,000건당 0.75달러 + 토큰 비용.`,
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
    description: '사용 가능한 DeepSeek 모델 목록.',
    inputSchema: { type: 'object', properties: {} },
    run: (io, cfg) => models(io, cfg),
  },
]

// 엔진($)에서 도구 구현이 쓰는 기능만 묶는다
function makeIO($: EngineInterface): IO {
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
      }
    },
    record: async (used, bal) => {
      const u = await update($, totals, prev => addUsage(prev, used))
      const b = bal ? await update($, balance, prev => nextBalance(prev, bal)) : await read($, balance)
      $.ui.status(statusText(u, b))
    },
  }
}

export const register: Register = (on, options) => {
  const optionKey = String(options.api_key ?? '')
  const allowOutside = options.allow_outside_workdir === true

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'deepseek-usage',
        description: '이 세션의 DeepSeek 워커 토큰 사용량과 계정 잔액을 자세히 보기',
      })
    } catch {
      // 같은 이름을 다른 플러그인(예전 deepseek-usage mod)이 이미 등록했으면 명령만 건너뛴다
    }
    // ~/.config/deepseek/disabled 가 있으면 도구를 아예 등록하지 않는다
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    if (!(await $.fs.exists(disabledFile(home)))) {
      for (const t of TOOLS) await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema })
    }
    // 다시 불러와도 합계는 $.state에 남아 있으므로 상태 줄을 되살린다
    $.ui.status(statusText(await read($, totals), await read($, balance)))
    return next(e)
  })

  // Claude에게 언제 맡기고 언제 직접 할지 알려 주는 지침
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    if (await $.fs.exists(disabledFile(home))) return r
    return { sections: [...r.sections, { id: `${PLUGIN}:guide`, text: GUIDE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'deepseek-usage' }, async $ => {
    const u = await read($, totals)
    if (u.calls === 0) return { text: await keyCheckText(makeIO($), optionKey) }
    return { text: detailText(u, await read($, balance)) }
  })

  on('tool.call', { tool: /^mcp__deepseek-worker__deepseek_(chat|batch|research|models)$/ }, async ($, e) => {
    const t = TOOLS.find(x => TOOL(x.name) === e.tool)
    if (!t) return { deny: `알 수 없는 도구: ${e.tool}` }
    const io = makeIO($)
    try {
      if (await io.exists(disabledFile(await homeDir(io)))) return { result: DISABLED_MESSAGE }
      const cfg = await loadConfig(io, optionKey, allowOutside)
      return { result: await t.run(io, cfg, { ...(e as object) } as Args) }
    } catch (err) {
      return { deny: `${t.name} 실패: ${(err as Error).message}` }
    }
  })
}
