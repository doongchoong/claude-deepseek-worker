// 이 세션에서 DeepSeek 워커에 쓴 토큰 합계
export type Usage = {
  calls: number
  input: number
  output: number
  hit: number
  miss: number
  reasoning: number
  lastIn: number
  lastOut: number
  model: string
}

// 계정 잔액: 세션에서 처음 본 값(start)과 마지막으로 본 값(now)
export type Balance = { currency: string; start: number; now: number } | null

declare module 'claude-code' {
  interface PluginState {
    'deepseek-worker': { totals: Shaped<Usage>; balance: Shaped<Balance> }
  }
}
