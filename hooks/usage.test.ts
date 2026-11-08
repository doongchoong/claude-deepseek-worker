import { expect, test } from 'claude-code/testing'

const CHAT = 'mcp__deepseek-worker__deepseek_chat'
const BATCH = 'mcp__deepseek-worker__deepseek_batch'

type Reply = { content: string; finish?: string; usage?: Record<string, unknown> }

type WorldOptions = {
  balances?: string[]
  disabled?: boolean
  keyFile?: boolean
  badKey?: boolean
  // Extra environment variables (LANG and friends)
  env?: Record<string, string>
  // What `defaults read -g AppleLanguages` prints; when set, /usr/bin/defaults exists
  appleLanguages?: string
}

// Mocks the DeepSeek API, the disk, the environment and Claude Code's permission decisions in memory
function world(on: any, replies: Reply[], opts: WorldOptions = {}) {
  const sent: any[] = []
  const argv0: string[] = []
  const auths: string[] = []
  let running = 0
  const peak = { n: 0 }
  const written: Record<string, string> = {}
  const statuses: (string | undefined)[] = []
  const commands: { name: string; description: string }[] = []
  const balances = opts.balances ?? ['4.38']
  let b = 0

  on('command.register', (_: unknown, e: any) => {
    commands.push({ name: e.name, description: e.description })
    return { value: { command: 'deepseek-usage' } }
  })
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__deepseek-worker__${e.name}` } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('ui.status', (_: unknown, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('env.get', (_: unknown, e: any) => ({
    // DEEPSEEK_API_KEY is set, but the plugin must never read it
    value: ({ HOME: '/home/u', DEEPSEEK_API_KEY: 'env-key', ...opts.env } as Record<string, string>)[e.name],
  }))
  // Disk: working folder /work with a.py and .env, /etc/passwd outside it, a scratchpad, the OS curl, and the key file
  const disk = new Set(['/', '/work', '/work/a.py', '/work/.env', '/etc', '/etc/passwd', '/tmp', '/tmp/scratch', '/tmp/scratch/x.py', '/usr/bin/curl'])
  if (opts.keyFile !== false) disk.add('/home/u/.config/deepseek/api_key')
  if (opts.appleLanguages !== undefined) disk.add('/usr/bin/defaults')
  on('session.cwd', () => ({ value: '/work' }))
  // Claude Code's permission decision: the scratchpad is allowed, .env has a deny rule, reads in the working folder
  // are allowed, writes in the working folder are ask (as in the default mode), anything else is ask
  const checks: string[] = []
  on('tool.check', (_: unknown, e: any) => {
    const path: string = e.input.file_path
    checks.push(`${e.tool} ${path}`)
    if (path.startsWith('/tmp/scratch/')) return { decision: 'allow' }
    if (path.endsWith('/.env')) return { decision: 'deny', reason: 'rule Read(.env)', rule: 'Read(.env)' }
    if (e.tool === 'Read' && path.startsWith('/work/')) return { decision: 'allow' }
    return { decision: 'ask' }
  })
  on('fs.exists', (_: unknown, e: any) => ({
    value: disk.has(e.path) || (!!opts.disabled && e.path.endsWith('/disabled')),
  }))
  // Links in the working folder: one to a secret key outside it, one to the deny-ruled .env
  const links: Record<string, string> = { '/work/key-link': '/home/u/.ssh/id_rsa', '/work/env-link': '/work/.env' }
  on('fs.stat', (_: unknown, e: any) =>
    links[e.path]
      ? { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: true, realPath: links[e.path] } }
      : disk.has(e.path)
        ? { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
        : { deny: 'ENOENT' },
  )
  on('fs.read', () => ({ value: 'FILE BODY' }))
  on('fs.write', (_: unknown, e: any) => {
    written[e.path.split('/').pop()] = e.text // the engine hands over relative paths made absolute
    return { value: undefined }
  })
  // Short calls (the balance) come through $.http.fetch
  on('http.fetch', (_: unknown, e: any) => {
    if (opts.badKey) return { value: { status: 401, ok: false, headers: {}, text: '{"error":{"message":"Authentication Fails"}}' } }
    const total = balances[Math.min(b++, balances.length - 1)]
    const v = { balance_infos: [{ currency: 'USD', total_balance: total }] }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(v) } }
  })
  // Generation comes through curl streaming: take the body from the curl config on stdin and answer in SSE chunks
  on('process.spawn', async function* (_: unknown, e: any) {
    if (e.argv[0] === '/usr/bin/defaults') {
      yield { stream: 'stdout', text: opts.appleLanguages ?? '' }
      return { value: { code: 0, signal: null } }
    }
    argv0.push(e.argv[0])
    peak.n = Math.max(peak.n, ++running)
    auths.push(e.input.split('\n').find((l: string) => l.includes('Authorization')) ?? '')
    const line = e.input.split('\n').find((l: string) => l.startsWith('data-binary = '))
    const body = JSON.parse(JSON.parse(line.slice('data-binary = '.length)))
    sent.push(body)
    const r = replies[(sent.length - 1) % replies.length]!
    const usage = r.usage ?? { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50 }
    const half = Math.ceil(r.content.length / 2)
    for (const piece of [r.content.slice(0, half), r.content.slice(half)]) {
      yield { stream: 'stdout', text: `data: ${JSON.stringify({ model: 'deepseek-flash', choices: [{ delta: { content: piece } }] })}\n\n` }
    }
    yield {
      stream: 'stdout',
      text:
        `data: ${JSON.stringify({ model: 'deepseek-flash', choices: [{ delta: {}, finish_reason: r.finish ?? 'stop' }] })}\n\n` +
        `data: ${JSON.stringify({ model: 'deepseek-flash', choices: [], usage })}\n\ndata: [DONE]\n\n`,
    }
    running--
    return { value: { code: 0, signal: null } }
  })
  return { sent, written, statuses, argv0, auths, peak, checks, commands }
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
const text = (r: any) => String(r.result)
const refusal = (r: any) => String(r.deny ?? r.text)
const usage = async ($: any) => (await $.command.run({ command: 'deepseek-usage', args: '' } as any)).text as string

test('chat: sends reasoning_effort high explicitly and adds usage and balance to the result and status line', async ($, on) => {
  const w = world(on, [{ content: '4' }])
  await start($)
  const r = await $.tool.call({ tool: CHAT, prompt: '2+2?' })

  expect(w.sent[0].reasoning_effort).toBe('high')
  expect(w.argv0[0]).toBe('/usr/bin/curl') // the OS curl by absolute path, not whatever is on PATH
  expect(w.sent[0].max_tokens).toBeUndefined()
  expect(w.sent[0].messages[0].content).toContain('higher-level agent (Claude)')
  expect(w.sent[0].messages[0].content).toContain('in the language of the request')
  expect(text(r)).toContain('4\n\n[usage: deepseek-flash, in=100 out=20 hit=50 miss=50]')
  expect(text(r)).toContain('[balance: USD 4.38]')
  expect(w.statuses.at(-1)).toBe('1 call 120tok hit 50% $4.38')
})

test('chat: files go before the prompt; output_path saves to the file with max_tokens 300000', async ($, on) => {
  const w = world(on, [{ content: '```python\nprint(1)\n```' }])
  await start($)
  const r = await $.tool.call({ tool: CHAT, prompt: 'write it', files: ['a.py'], output_path: 'out.py', reasoning_effort: 'low' })

  expect(w.sent[0].max_tokens).toBe(300000)
  expect(w.sent[0].reasoning_effort).toBe('low')
  expect(w.sent[0].messages[1].content.startsWith('<file path="a.py">\nFILE BODY\n</file>')).toBe(true)
  expect(w.written['out.py']).toBe('print(1)\n') // the code fence is stripped
  expect(text(r)).toContain('saved: /work/out.py (1 lines')
})

test('chat: a truncated reply goes to .partial and an empty one is not saved, keeping the original file', async ($, on) => {
  const w = world(on, [{ content: 'print(1)\nprint(', finish: 'length' }, { content: '', finish: 'length' }])
  await start($)
  const cut = await $.tool.call({ tool: CHAT, prompt: 'x', output_path: 'out.py' })
  const empty = await $.tool.call({ tool: CHAT, prompt: 'x', output_path: 'out.py' })

  expect(Object.keys(w.written)).toEqual(['out.py.partial'])
  expect(text(cut)).toContain('[truncated]')
  expect(text(cut)).toContain('out.py unchanged')
  expect(text(empty)).toContain('[not saved]')
})

test('batch: counts usage per job; /deepseek-usage shows the totals and balance spent', async ($, on) => {
  world(on, [{ content: 'a' }], { balances: ['4.38', '4.35'] })
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x' })
  const r = await $.tool.call({ tool: BATCH, prompts: ['p', 'q'] })

  expect(text(r)).toContain('=== #0 ===\na')
  expect(text(r)).toContain('=== #1 ===\na')
  const out = await usage($)
  expect(out).toContain('Calls            3')
  expect(out).toContain('Balance          $4.35 (first seen $4.38, spent since $0.03)')
})

test('an invalid reasoning_effort is refused without calling the API', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const r: any = await $.tool.call({ tool: CHAT, prompt: 'x', reasoning_effort: 'medium' })

  expect(refusal(r)).toContain('reasoning_effort must be one of none, low, high, max')
  expect(w.sent.length).toBe(0)
})

test('with ~/.config/deepseek/disabled present, the API is not called', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { disabled: true })
  await start($)
  const r = await $.tool.call({ tool: CHAT, prompt: 'x' })

  expect(text(r)).toContain('[disabled]')
  expect(w.sent.length).toBe(0)
})

test('files and output_path outside the working folder are refused before calling the API', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const read: any = await $.tool.call({ tool: CHAT, prompt: 'x', files: ['/etc/passwd'] })
  const write: any = await $.tool.call({ tool: CHAT, prompt: 'x', output_path: '../out.py' })

  expect(refusal(read)).toContain('outside the working folder (/work)')
  expect(refusal(write)).toContain('outside the working folder (/work)')
  expect(w.sent.length).toBe(0)
  expect(Object.keys(w.written).length).toBe(0)
})

test('allow_outside_workdir lets files outside the working folder be read', { options: { allow_outside_workdir: true } }, async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x', files: ['/etc/passwd'] })

  expect(w.sent.length).toBe(1)
})

test('the key never comes from an environment variable: with no option and no key file, refuse', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { keyFile: false })
  await start($)
  const r: any = await $.tool.call({ tool: CHAT, prompt: 'x' })

  expect(refusal(r)).toContain('No DeepSeek API key')
  expect(refusal(r)).not.toContain('DEEPSEEK_API_KEY')
  expect(w.sent.length).toBe(0)
})

test('the plugin option key comes before the key file', { options: { api_key: 'option-key' } }, async ($, on) => {
  const w = world(on, [{ content: 'x' }], { keyFile: false })
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x' })

  expect(w.auths[0]).toContain('Bearer option-key')
})

test('with the option empty, the key file is used and the environment variable is not', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x' })

  expect(w.auths[0]).toContain('Bearer FILE BODY')
  expect(w.auths[0]).not.toContain('env-key')
})

test('/deepseek-usage before any call looks up the balance to show the key works', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)

  expect(await usage($)).toBe('No DeepSeek calls in this session yet.\nKey OK, balance $4.38')
  expect(w.sent.length).toBe(0) // no generation call
})

test('/deepseek-usage says so when there is no key', async ($, on) => {
  world(on, [{ content: 'x' }], { keyFile: false })
  await start($)
  expect(await usage($)).toContain('No DeepSeek API key')
})

test('/deepseek-usage shows the HTTP error when the API rejects the key', async ($, on) => {
  world(on, [{ content: 'x' }], { badKey: true })
  await start($)
  expect(await usage($)).toContain('Key check failed: DeepSeek API /user/balance → HTTP 401')
})

test('batch: concurrency is clamped to 1-16, and a non-number falls back to the default and runs everything', async ($, on) => {
  const w = world(on, [{ content: 'a' }])
  await start($)
  const prompts = Array.from({ length: 20 }, (_, i) => `p${i}`)
  await $.tool.call({ tool: BATCH, prompts, concurrency: 100 })
  expect(w.peak.n).toBeGreaterThan(1) // really ran in parallel
  expect(w.peak.n).toBeLessThanOrEqual(16)
  expect(w.sent.length).toBe(20)

  const r = await $.tool.call({ tool: BATCH, prompts: ['a', 'b'], concurrency: 'many' } as any)
  expect(text(r)).toContain('=== #1 ===\na')
  expect(w.sent.length).toBe(22)
})

test('the session scratchpad, which Claude Code allows, is read and written even outside the working folder', async ($, on) => {
  const w = world(on, [{ content: 'print(1)' }])
  await start($)
  const r = await $.tool.call({ tool: CHAT, prompt: 'x', files: ['/tmp/scratch/x.py'], output_path: '/tmp/scratch/out.py' })

  expect(text(r)).toContain('saved: /tmp/scratch/out.py')
  expect(w.checks).toContain('Read /tmp/scratch/x.py')
  expect(w.checks).toContain('Write /tmp/scratch/out.py')
})

test('a file blocked by a deny rule never goes to DeepSeek, even inside the working folder', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const r: any = await $.tool.call({ tool: CHAT, prompt: 'x', files: ['.env'] })

  expect(refusal(r)).toContain("Claude Code's permission settings block it")
  expect(refusal(r)).toContain('rule Read(.env)')
  expect(w.sent.length).toBe(0)
})

test('an ask verdict still lets a write inside the working folder go ahead (default permission mode)', async ($, on) => {
  const w = world(on, [{ content: 'print(1)' }])
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x', output_path: 'sub/out.py' })

  expect(w.checks).toContain('Write /work/sub/out.py')
  expect(w.written['out.py']).toBe('print(1)\n')
})

test('a link in the working folder pointing outside it or at a deny-ruled file is not sent', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const outside: any = await $.tool.call({ tool: CHAT, prompt: 'x', files: ['key-link'] })
  const denied: any = await $.tool.call({ tool: CHAT, prompt: 'x', files: ['env-link'] })

  expect(refusal(outside)).toContain('link to /home/u/.ssh/id_rsa')
  expect(refusal(denied)).toContain("Claude Code's permission settings block it")
  expect(w.checks).toContain('Read /home/u/.ssh/id_rsa') // the real target was asked about too
  expect(w.sent.length).toBe(0)
})

// ───────── Language of what people read ─────────

test('language ko: status line, /deepseek-usage and the command description are in Korean', { options: { language: 'ko' } }, async ($, on) => {
  const w = world(on, [{ content: 'a' }], { balances: ['4.38', '4.35'] })
  await start($)
  expect(await usage($)).toBe('이 세션에서는 아직 DeepSeek를 호출하지 않았어요.\n키 정상, 계정 잔액 $4.38')

  await $.tool.call({ tool: CHAT, prompt: 'x' })
  expect(w.statuses.at(-1)).toBe('1회 120tok hit 50% $4.35')
  expect(await usage($)).toContain('호출          1회')
  expect(w.commands[0]?.description).toContain('사용량')
  // What the model reads stays English
  expect(w.sent[0].messages[0].content).toContain('higher-level agent (Claude)')
})

test('language auto follows LANG', async ($, on) => {
  const w = world(on, [{ content: 'a' }], { env: { LANG: 'ko_KR.UTF-8' } })
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x' })
  expect(w.statuses.at(-1)).toBe('1회 120tok hit 50% $4.38')
})

test('language auto skips LANG=C and uses the macOS system language', async ($, on) => {
  const w = world(on, [{ content: 'a' }], { env: { LANG: 'C' }, appleLanguages: '(\n    "ko-KR",\n    "en-US"\n)\n' })
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x' })
  expect(w.statuses.at(-1)).toBe('1회 120tok hit 50% $4.38')
})

test('language auto falls back to English; the en option beats a Korean LANG', { options: { language: 'en' } }, async ($, on) => {
  const w = world(on, [{ content: 'a' }], { env: { LANG: 'ko_KR.UTF-8' } })
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x' })
  expect(w.statuses.at(-1)).toBe('1 call 120tok hit 50% $4.38')
  expect(w.commands[0]?.description).toContain('usage')
})
