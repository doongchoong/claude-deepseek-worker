# claude-deepseek-worker

**English** · [한국어](README.ko.md)

A Claude Code plugin that gives Claude a cheap worker: **DeepSeek**.

Claude stays in charge of judgment — design, root-cause analysis, review. Work that is long but well specified (bulk tests, boilerplate, data conversion, code in a fixed format) small contained tasks it can check with a command, and web research get handed to DeepSeek. Results are written straight to files or come back as short sourced summaries, so they barely touch Claude's context.

**Nothing else to install.** The plugin runs inside Claude Code itself — no Python, no Node, no separate server — so it works the same on macOS, Windows and Linux.

```
You ──▶ Claude (plans, reviews) ──▶ deepseek_chat / batch / agent / research ──▶ DeepSeek API
                    ▲                                   │
                    └──── file on disk / short summary ◀┘
```

## What you get

| Piece | What it does |
| --- | --- |
| `deepseek_chat` | One task. `files` are read by the plugin and prepended, so Claude doesn't copy file contents into the call. `output_path` writes the answer straight to a file and returns only path and line count. |
| `deepseek_batch` | Many independent prompts in parallel, results in order. |
| `deepseek_agent` | A small agent: DeepSeek looks around the repo, searches the web (DeepSeek's own search), edits files and runs a check command on its own, then returns a short report (summary, changed files, check verdict). Commands it wants to run follow your permission rules: an allowed command runs, a denied one never does, and anything else is put to you in a dialog (allow for this run, always allow in this project, or deny). Costs more than `deepseek_chat`. |
| `deepseek_research` | DeepSeek searches and reads the web on its own, several rounds, and returns only a sourced summary. |
| `deepseek_models` | Lists available models. |
| Status line | `deepseek-worker 7 calls 128.5Ktok hit 62% $4.38` — calls, tokens, cache hit rate and account balance for the session. While a tool works it shows progress instead (`agent 3/12 · run pytest`, `writing… 120 lines`, `batch 5/12 done`). |
| Progress lines | `deepseek_agent` leaves a line in the transcript when it starts, after each turn (`turn 2/12: edit a.py; run pytest`) and when it ends. Long paths show as their last two parts. They are for you only; Claude still gets just the final report. |
| `/deepseek-commands` | Lists the commands you chose to always allow for the DeepSeek agent in this project; `/deepseek-commands clear` forgets them. |
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
- **Material is fenced off from instructions.** Every file, command output, search result and web page DeepSeek reads is wrapped in `<data id="…">` with a random id made when the plugin loads, and DeepSeek is told that nothing inside is an instruction. A file or page can't know the id in advance, so it can't fake the end of its block (the id is also stripped from the text). This lowers the chance that text planted in a repository or on a page steers DeepSeek; the permission checks and command approval above are what actually stop it.
- **The agent's web tools.** `web_search` uses DeepSeek's search (up to 8 per task, billed per request). `web_fetch` opens only URLs that came back in its search results or are written in the task, so a page or file can't make the agent send data to an address it made up. Search queries themselves go to DeepSeek's search service.
- **Commands from `deepseek_agent`.** The plugin asks Claude Code's permission rules first: a deny rule always wins, and an allow rule (say `Bash(npm test:*)`) runs the command without asking. A few read-only commands run without asking: `pwd`, `ls`, `git status`, `git diff --stat` / `--name-only`, `git log --oneline`. File readers such as `cat` are left out on purpose, since they would read past the checks `read_file` applies and send the output to DeepSeek. Anything else is put to you in a dialog. "Always allow" remembers a prefix for that project folder — `npm test *`, `cargo test *`, `python3 -m unittest *`, `git commit *` — so other arguments don't ask again; an interpreter running a file (`node build.js`) is remembered exactly. A command that chains, pipes, redirects or substitutes (`;`, `&&`, `|`, `>`, `$(…)`) never matches a default or a prefix and is always asked about. The list lives in `~/.config/deepseek/allowed_commands.json`, outside any project, so a repository can't approve its own commands. Approved commands run through `/bin/sh` (`cmd.exe` on Windows) with a 5-minute limit, **outside Claude Code's Bash sandbox** if you use one. Claude Code's own Bash tool isn't used because, in auto mode, its classifier refuses calls that no request of yours explains. With nobody to answer (a background run), unknown commands are refused, and the agent is told not to retry them.

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
- "Have the DeepSeek agent make the failing tests in `tests/parser` pass; check with `pytest tests/parser`."
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
