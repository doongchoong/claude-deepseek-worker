# claude-deepseek-worker

**English** · [한국어](README.ko.md)

A Claude Code plugin that gives Claude a cheap worker: **DeepSeek**.

Claude stays in charge of judgment — design, root-cause analysis, review. Work that is long but well specified (bulk tests, boilerplate, data conversion, code in a fixed format) and web research get handed to DeepSeek. Results are written straight to files or come back as short sourced summaries, so they barely touch Claude's context.

**Nothing else to install.** The plugin runs inside Claude Code itself — no Python, no Node, no separate server — so it works the same on macOS, Windows and Linux.

```
You ──▶ Claude (plans, reviews) ──▶ deepseek_chat / batch / research ──▶ DeepSeek API
                    ▲                                   │
                    └──── file on disk / short summary ◀┘
```

## What you get

| Piece | What it does |
| --- | --- |
| `deepseek_chat` | One task. `files` are read by the plugin and prepended, so Claude doesn't copy file contents into the call. `output_path` writes the answer straight to a file and returns only path and line count. |
| `deepseek_batch` | Many independent prompts in parallel, results in order. |
| `deepseek_research` | DeepSeek searches and reads the web on its own, several rounds, and returns only a sourced summary. |
| `deepseek_models` | Lists available models. |
| Status line | `deepseek-worker 7 calls 128.5Ktok hit 62% $4.38` — calls, tokens, cache hit rate and account balance for the session. |
| `/deepseek-usage` | Detailed usage for the session: cached / uncached input, output, reasoning, balance spent. Before the first call it checks the key and shows the balance (free). |
| Guidance for Claude | When to delegate and when to do it itself, and how to keep DeepSeek's prompt cache warm — added to Claude's system prompt. |

Safety details that matter when a worker writes your files:

- **Long outputs don't get cut off silently.** `output_path` calls default to `max_tokens=300000` (reasoning tokens share that budget). If a reply is still truncated it is saved to `<output_path>.partial` and **the original file is left untouched**, with a `[truncated]` line in the result.
- **An empty reply never overwrites a file.**
- `reasoning_effort` (`none` · `low` · `high` · `max`) is always sent explicitly; default `high`.
- **Files follow Claude Code's own permissions.** Before `files` are read or `output_path` is written, the plugin asks Claude Code whether Claude itself could Read / Write that path. Whatever Claude may use — the working folder, the session's scratchpad, folders added with `/add-dir` — works; files you blocked with a deny rule (say `Read(.env)`) are never sent to DeepSeek. A link is checked twice, as itself and as the file it points to, so a link in the working folder can't reach a file outside it or one a deny rule blocks. A path Claude Code would ask about is allowed only inside the working folder. Turn on the plugin option `allow_outside_workdir` to skip these checks.

## Security notes

- The API key lives in your OS's secure storage when set through the plugin option. It is handed to `curl` on standard input, never on the command line, so it doesn't show up in process lists.
- Generation requests run through the system's own `curl` by absolute path (`/usr/bin/curl`, or `%SystemRoot%\System32\curl.exe` on Windows), not whatever `curl` comes first on `PATH`. They take longer than the 30 seconds Claude Code's built-in fetch allows, and are streamed so a long answer arrives whole. Because `curl` is a separate process, those requests don't pass through Claude Code's own network policy.
- Everything you put in a prompt or `files` is sent to DeepSeek's servers. Keep secrets and data you may not share out of it.
- Web research returns text written by web pages; Claude treats it as information, not instructions.

## Requirements

- [Claude Code](https://claude.com/claude-code) — terminal, the desktop app's Code tab, or an IDE extension
- A [DeepSeek API key](https://platform.deepseek.com/)

The plugin uses Claude Code's plugin runtime, so it does not run in the Claude desktop app's chat tab or on claude.ai.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install deepseek-worker --marketplace doongchoong/claude-deepseek-worker
```

Answer `y` to add the marketplace, then pick a scope (user scope = every project). The plugin asks for your **DeepSeek API key** and keeps it in secure storage.

From a shell:

```bash
claude plugin install deepseek-worker --marketplace doongchoong/claude-deepseek-worker
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `doongchoong/claude-deepseek-worker` → **Add plugin**.

If the plugin option is empty, the key is read from `~/.config/deepseek/api_key` (on Windows, `%USERPROFILE%\.config\deepseek\api_key`). Make that file readable only by you (`chmod 600` on macOS/Linux). The key is never read from an environment variable: every program started from your shell inherits environment variables, and a plain `env` prints them.

## Using it

Just talk to Claude. It decides on its own when delegating is cheaper than writing it itself, and you can always be explicit:

- "Have DeepSeek write unit tests for `parser.py` into `tests/test_parser.py`, then run them."
- "Use DeepSeek research: what changed in the latest Python release?"
- "Give DeepSeek these 12 conversion jobs as a batch."
- "Ask DeepSeek with effort low" — less reasoning, faster and cheaper for very detailed specs.

Claude reviews what comes back (runs the tests, reads parts of the file). After two failed re-instructions it writes the code itself.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DEEPSEEK_MODEL` | `deepseek-flash` | Default model |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API endpoint |

**Language:** the status line and `/deepseek-usage` come in English or Korean. The plugin option `language` is `auto` by default: it follows `LC_ALL` / `LC_MESSAGES` / `LANG`, then the macOS system language, and falls back to English (on Windows set it yourself). Set it to `en` or `ko` in `/plugin` to choose. Everything the models read — tool descriptions, Claude's guidance, DeepSeek's prompts — is English; DeepSeek is told to answer in the language of the request, so a Korean request still gets Korean back.

**Turning it off for a while:** `/plugin disable deepseek-worker`, or create the file `~/.config/deepseek/disabled` (new sessions don't register the tools; running ones answer "disabled"). Delete the file to turn it back on.

## Cost

You pay DeepSeek's token prices; web research adds DeepSeek's Search/Fetch price (USD 0.75 per 1,000 successful searches or fetches at the time of writing). The status line shows your balance after every call. Most of the cost of code generation is output and reasoning tokens — `reasoning_effort: "low"` is the biggest lever.

## How it's built

```
.claude-plugin/plugin.json       plugin manifest and the API key option
.claude-plugin/marketplace.json  makes this repo installable with /plugin install
hooks/register.ts                the tools, Claude's guidance, status line, /deepseek-usage
hooks/usage.test.ts              tests with DeepSeek, files and env mocked (claude plugin test .)
types/index.d.ts                 the shape of the plugin's state (usage, balance, language)
```

The tools are registered with Claude Code's plugin API (`$.tool.register`) and call DeepSeek through `$.http.fetch`; files are read and written through `$.fs`. Text the models read is English; text people read is English or Korean (see **Language** above).

**Releasing a change:** bump `version` in `.claude-plugin/plugin.json` with every push. Installs are cached per version, so a change pushed under the same version may never reach people who already installed it. They pick it up with `claude plugin update deepseek-worker@claude-deepseek-worker`.

## License

[MIT](LICENSE)
