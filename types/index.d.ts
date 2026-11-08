// Tokens spent on the DeepSeek worker in this session
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

// Account balance: the first value seen in the session (start) and the latest (now)
export type Balance = { currency: string; start: number; now: number } | null

// The language people read, decided once per session for the `language` option it was decided under
export type UiLang = { option: string; lang: 'en' | 'ko' } | null

declare module 'claude-code' {
  interface PluginState {
    'deepseek-worker': { totals: Shaped<Usage>; balance: Shaped<Balance>; uiLang: Shaped<UiLang> }
  }
}
