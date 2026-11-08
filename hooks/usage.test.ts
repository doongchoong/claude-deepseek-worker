import { expect, test } from 'claude-code/testing'

const CHAT = 'mcp__deepseek-worker__deepseek_chat'
const BATCH = 'mcp__deepseek-worker__deepseek_batch'

type Reply = { content: string; finish?: string; usage?: Record<string, unknown> }

// DeepSeek API, 파일, 환경변수를 메모리로 흉내 낸다
function world(on: any, replies: Reply[], opts: { balances?: string[]; disabled?: boolean; keyFile?: boolean; badKey?: boolean } = {}) {
  const sent: any[] = []
  const argv0: string[] = []
  const auths: string[] = []
  let running = 0
  const peak = { n: 0 }
  const written: Record<string, string> = {}
  const statuses: (string | undefined)[] = []
  const balances = opts.balances ?? ['4.38']
  let b = 0

  on('command.register', () => ({ value: { command: 'deepseek-usage' } }))
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__deepseek-worker__${e.name}` } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('ui.status', (_: unknown, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('env.get', (_: unknown, e: any) => ({
    // DEEPSEEK_API_KEY가 있어도 플러그인은 읽지 않아야 한다
    value: ({ HOME: '/home/u', DEEPSEEK_API_KEY: 'env-key' } as Record<string, string>)[e.name],
  }))
  // 디스크: 작업 폴더 /work, 그 안의 a.py, 바깥의 /etc/passwd, OS의 curl, 그리고 키 파일
  const disk = new Set(['/', '/work', '/work/a.py', '/etc', '/etc/passwd', '/usr/bin/curl'])
  if (opts.keyFile !== false) disk.add('/home/u/.config/deepseek/api_key')
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', (_: unknown, e: any) => ({
    value: disk.has(e.path) || (!!opts.disabled && e.path.endsWith('/disabled')),
  }))
  on('fs.stat', (_: unknown, e: any) =>
    disk.has(e.path)
      ? { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
      : { deny: 'ENOENT' },
  )
  on('fs.read', () => ({ value: 'FILE BODY' }))
  on('fs.write', (_: unknown, e: any) => {
    written[e.path.split('/').pop()] = e.text // 엔진이 상대 경로를 절대 경로로 바꿔 넘긴다
    return { value: undefined }
  })
  // 짧은 호출(잔액)은 $.http.fetch로 온다
  on('http.fetch', (_: unknown, e: any) => {
    if (opts.badKey) return { value: { status: 401, ok: false, headers: {}, text: '{"error":{"message":"Authentication Fails"}}' } }
    const total = balances[Math.min(b++, balances.length - 1)]
    const v = { balance_infos: [{ currency: 'USD', total_balance: total }] }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(v) } }
  })
  // 생성은 curl 스트리밍으로 온다: 표준 입력의 curl 설정에서 본문을 꺼내고 SSE 조각으로 답한다
  on('process.spawn', async function* (_: unknown, e: any) {
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
  return { sent, written, statuses, argv0, auths, peak }
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
const text = (r: any) => String(r.result)

test('chat: 기본 사고량 high를 명시해 보내고, 사용량과 잔액을 결과·상태 줄에 붙인다', async ($, on) => {
  const w = world(on, [{ content: '4' }])
  await start($)
  const r = await $.tool.call({ tool: CHAT, prompt: '2+2?' })

  expect(w.sent[0].reasoning_effort).toBe('high')
  expect(w.argv0[0]).toBe('/usr/bin/curl') // PATH가 아니라 OS의 curl을 절대 경로로
  expect(w.sent[0].max_tokens).toBeUndefined()
  expect(w.sent[0].messages[0].content).toContain('상위 에이전트(Claude)')
  expect(text(r)).toContain('4\n\n[usage: deepseek-flash, in=100 out=20 hit=50 miss=50]')
  expect(text(r)).toContain('[balance: USD 4.38]')
  expect(w.statuses.at(-1)).toBe('1회 120tok hit 50% $4.38')
})

test('chat: files는 프롬프트 앞에 붙고, output_path면 max_tokens 300000으로 파일에 저장한다', async ($, on) => {
  const w = world(on, [{ content: '```python\nprint(1)\n```' }])
  await start($)
  const r = await $.tool.call({ tool: CHAT, prompt: 'write it', files: ['a.py'], output_path: 'out.py', reasoning_effort: 'low' })

  expect(w.sent[0].max_tokens).toBe(300000)
  expect(w.sent[0].reasoning_effort).toBe('low')
  expect(w.sent[0].messages[1].content.startsWith('<file path="a.py">\nFILE BODY\n</file>')).toBe(true)
  expect(w.written['out.py']).toBe('print(1)\n') // 코드 펜스를 벗긴다
  expect(text(r)).toContain('saved: /work/out.py (1 lines')
})

test('chat: 잘린 응답은 .partial로, 빈 응답은 저장하지 않아 원래 파일을 지킨다', async ($, on) => {
  const w = world(on, [{ content: 'print(1)\nprint(', finish: 'length' }, { content: '', finish: 'length' }])
  await start($)
  const cut = await $.tool.call({ tool: CHAT, prompt: 'x', output_path: 'out.py' })
  const empty = await $.tool.call({ tool: CHAT, prompt: 'x', output_path: 'out.py' })

  expect(Object.keys(w.written)).toEqual(['out.py.partial'])
  expect(text(cut)).toContain('[truncated]')
  expect(text(cut)).toContain('out.py는 그대로')
  expect(text(empty)).toContain('[not saved]')
})

test('batch: 건마다 사용량을 세고 /deepseek-usage에 합계와 잔액 사용액을 보여준다', async ($, on) => {
  world(on, [{ content: 'a' }], { balances: ['4.38', '4.35'] })
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x' })
  const r = await $.tool.call({ tool: BATCH, prompts: ['p', 'q'] })

  expect(text(r)).toContain('=== #0 ===\na')
  expect(text(r)).toContain('=== #1 ===\na')
  const out = await $.command.run({ command: 'deepseek-usage', args: '' } as any)
  expect(out.text).toContain('호출          3회')
  expect(out.text).toContain('계정 잔액     $4.35 (첫 조회 $4.38, 그 뒤 사용 $0.03)')
})

test('잘못된 reasoning_effort는 API를 부르지 않고 거절한다', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const r: any = await $.tool.call({ tool: CHAT, prompt: 'x', reasoning_effort: 'medium' })

  expect(String(r.deny ?? r.text)).toContain('reasoning_effort는 none, low, high, max 중 하나')
  expect(w.sent.length).toBe(0)
})

test('~/.config/deepseek/disabled 가 있으면 API를 부르지 않는다', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { disabled: true })
  await start($)
  const r = await $.tool.call({ tool: CHAT, prompt: 'x' })

  expect(text(r)).toContain('[disabled]')
  expect(w.sent.length).toBe(0)
})

test('작업 폴더 밖의 files와 output_path는 API를 부르기 전에 거절한다', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  const read: any = await $.tool.call({ tool: CHAT, prompt: 'x', files: ['/etc/passwd'] })
  const write: any = await $.tool.call({ tool: CHAT, prompt: 'x', output_path: '../out.py' })

  expect(String(read.deny ?? read.text)).toContain('작업 폴더(/work) 밖')
  expect(String(write.deny ?? write.text)).toContain('작업 폴더(/work) 밖')
  expect(w.sent.length).toBe(0)
  expect(Object.keys(w.written).length).toBe(0)
})

test('allow_outside_workdir를 켜면 작업 폴더 밖 파일도 읽는다', { options: { allow_outside_workdir: true } }, async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x', files: ['/etc/passwd'] })

  expect(w.sent.length).toBe(1)
})

test('키는 환경변수에서 읽지 않는다: 옵션도 키 파일도 없으면 거절한다', async ($, on) => {
  const w = world(on, [{ content: 'x' }], { keyFile: false })
  await start($)
  const r: any = await $.tool.call({ tool: CHAT, prompt: 'x' })

  expect(String(r.deny ?? r.text)).toContain('DeepSeek API 키가 없습니다')
  expect(String(r.deny ?? r.text)).not.toContain('DEEPSEEK_API_KEY')
  expect(w.sent.length).toBe(0)
})

test('플러그인 옵션의 키가 키 파일보다 먼저 쓰인다', { options: { api_key: 'option-key' } }, async ($, on) => {
  const w = world(on, [{ content: 'x' }], { keyFile: false })
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x' })

  expect(w.auths[0]).toContain('Bearer option-key')
})

test('옵션이 비어 있으면 키 파일의 키를 쓰고, 환경변수의 키는 쓰지 않는다', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)
  await $.tool.call({ tool: CHAT, prompt: 'x' })

  expect(w.auths[0]).toContain('Bearer FILE BODY')
  expect(w.auths[0]).not.toContain('env-key')
})

const usage = async ($: any) => (await $.command.run({ command: 'deepseek-usage', args: '' } as any)).text as string

test('/deepseek-usage: 호출 전이면 잔액을 조회해 키가 정상인지 보여준다', async ($, on) => {
  const w = world(on, [{ content: 'x' }])
  await start($)

  expect(await usage($)).toContain('키 정상, 계정 잔액 $4.38')
  expect(w.sent.length).toBe(0) // 생성 호출은 하지 않는다
})

test('/deepseek-usage: 키가 없거나 틀리면 그렇다고 알려 준다', async ($, on) => {
  world(on, [{ content: 'x' }], { keyFile: false })
  await start($)
  expect(await usage($)).toContain('DeepSeek API 키가 없습니다')
})

test('/deepseek-usage: API가 키를 거절하면 HTTP 오류를 보여 준다', async ($, on) => {
  world(on, [{ content: 'x' }], { badKey: true })
  await start($)
  expect(await usage($)).toContain('키 확인 실패: DeepSeek API /user/balance → HTTP 401')
})

test('batch: concurrency는 1~16으로 자르고, 숫자가 아니면 기본값으로 모두 실행한다', async ($, on) => {
  const w = world(on, [{ content: 'a' }])
  await start($)
  const prompts = Array.from({ length: 20 }, (_, i) => `p${i}`)
  await $.tool.call({ tool: BATCH, prompts, concurrency: 100 })
  expect(w.peak.n).toBeGreaterThan(1) // 실제로 동시에 돌았다
  expect(w.peak.n).toBeLessThanOrEqual(16)
  expect(w.sent.length).toBe(20)

  const r = await $.tool.call({ tool: BATCH, prompts: ['a', 'b'], concurrency: 'many' } as any)
  expect(text(r)).toContain('=== #1 ===\na')
  expect(w.sent.length).toBe(22)
})
