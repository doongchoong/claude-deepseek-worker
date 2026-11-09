# claude-deepseek-worker

[English](README.md) · **한국어**

Claude에게 저렴한 워커 **DeepSeek**을 붙여 주는 Claude Code 플러그인이에요.

판단은 Claude가 해요. 설계, 원인 분석, 검수 같은 일이요. 길지만 명세가 분명한 작업(테스트 대량 작성, 보일러플레이트, 데이터 변환, 정해진 형식의 코드), 명령으로 확인할 수 있는 작은 단위의 작업, 웹 조사는 DeepSeek에 맡겨요. 결과는 파일로 바로 저장되거나 출처가 달린 짧은 요약으로만 돌아와서, Claude의 컨텍스트를 거의 쓰지 않아요.

**따로 설치할 게 없어요.** Claude Code 안에서 바로 실행돼요. Python도, Node도, 별도 서버도 필요 없어서 macOS, Windows, Linux에서 똑같이 동작해요.

```
나 ──▶ Claude (계획·검수) ──▶ deepseek_chat / batch / agent / research ──▶ DeepSeek API
              ▲                                  │
              └──── 저장된 파일 / 짧은 요약 ◀──────┘
```

## 들어 있는 것

| 구성 | 하는 일 |
| --- | --- |
| `deepseek_chat` | 작업 하나를 맡겨요. `files`는 플러그인이 직접 읽어서 프롬프트 앞에 붙이기 때문에, Claude가 파일 내용을 옮겨 적을 필요가 없어요. `output_path`를 주면 결과를 파일로 바로 저장하고 경로와 줄 수만 돌려줘요. |
| `deepseek_batch` | 서로 독립된 프롬프트 여러 개를 병렬로 처리하고 결과를 순서대로 돌려줘요. |
| `deepseek_agent` | 작은 에이전트예요. DeepSeek이 직접 저장소를 둘러보고, 웹을 검색하고(DeepSeek 자체 검색), 파일을 고치고, 확인 명령을 돌린 뒤 짧은 보고(요약, 바뀐 파일, 확인 결과)만 돌려줘요. 실행하려는 명령은 내 권한 규칙을 따라요. 허용된 명령은 바로 실행하고, 막힌 명령은 절대 실행하지 않고, 그 밖의 명령은 창을 띄워 물어봐요(이번 작업에만 허용, 이 프로젝트에서 항상 허용, 거부). `deepseek_chat`보다 비싸요. |
| `deepseek_research` | DeepSeek이 직접 여러 번 웹을 검색하고 페이지를 읽은 뒤, 출처가 달린 정리만 돌려줘요. |
| `deepseek_models` | 쓸 수 있는 모델 목록을 보여줘요. |
| 상태 줄 | `deepseek-worker 7회 128.5Ktok hit 62% $4.38`처럼 이 세션의 호출 수, 토큰, 캐시 적중률, 계정 잔액을 보여줘요(영어 설정이면 `7 calls`). 도구가 일하는 동안에는 진행 상황을 보여줘요(`에이전트 3/12턴 · run pytest`, `작성 중… 120줄`, `배치 5/12 완료`). |
| 진행 줄 | `deepseek_agent`가 시작할 때, 턴마다(`2/12턴: edit a.py; run pytest`), 끝날 때 대화창에 한 줄씩 남겨요. 긴 경로는 끝의 두 단계만 보여줘요. 사람에게만 보이고, Claude는 여전히 마지막 보고만 받아요. |
| `/deepseek-commands` | 이 프로젝트에서 DeepSeek 에이전트에게 "항상 허용"한 명령을 보여줘요. `/deepseek-commands clear`로 지울 수 있어요. |
| `/deepseek-usage` | 이 세션의 사용량을 자세히 보여줘요. 캐시된 입력과 안 된 입력, 출력, 추론 토큰, 사용한 금액이 나와요. 아직 호출 전이면 키가 맞는지 확인하고 잔액을 보여줘요(무료). |
| Claude용 지침 | 언제 맡기고 언제 직접 할지, DeepSeek 캐시를 잘 맞추는 방법을 Claude의 시스템 프롬프트에 넣어 줘요. |

워커가 내 파일을 쓰는 만큼 안전장치도 넣었어요.

- **긴 결과가 몰래 잘리지 않아요.** `output_path` 호출은 기본 `max_tokens`가 300000이에요(추론 토큰도 이 예산을 함께 써요). 그래도 잘리면 `<output_path>.partial`로 저장하고 **원래 파일은 그대로 둬요.** 결과에는 `[truncated]` 줄이 붙어요.
- **빈 응답은 파일을 덮어쓰지 않아요.**
- `reasoning_effort`(`none` · `low` · `high` · `max`)는 항상 명시해서 보내요. 기본값은 `high`예요.
- **파일 권한은 Claude Code를 그대로 따라요.** `files`를 읽거나 `output_path`에 쓰기 전에, Claude 자신이 그 경로를 Read/Write 도구로 다룰 수 있는지 Claude Code에 물어봐요. 그래서 작업 폴더, 세션 임시 폴더(scratchpad), `/add-dir`로 추가한 폴더처럼 Claude가 쓸 수 있는 곳은 다 되고, deny 규칙으로 막아 둔 파일(예: `Read(.env)`)은 DeepSeek으로 보내지 않아요. 링크는 링크 자체와 링크가 가리키는 실제 파일을 둘 다 확인해요. 그래서 작업 폴더 안의 링크로 밖의 파일이나 deny 규칙으로 막은 파일을 읽을 수 없어요. Claude Code가 "확인 필요"로 판단하는 경로는 작업 폴더 안일 때만 허용해요. 이 확인을 건너뛰려면 플러그인 옵션 `allow_outside_workdir`를 켜세요.

## 보안 참고

- 플러그인 옵션으로 넣은 API 키는 OS 보안 저장소에 보관돼요. `curl`에는 명령줄 인자가 아니라 표준 입력으로 넘겨서, 프로세스 목록에 드러나지 않아요.
- 생성 요청은 OS에 들어 있는 `curl`을 절대 경로로 실행해요(`/usr/bin/curl`, Windows는 `%SystemRoot%\System32\curl.exe`). `PATH`에서 먼저 찾은 `curl`을 쓰지 않아요. Claude Code 내장 fetch는 30초 안에 끝나야 해서, 시간이 걸리는 생성은 스트리밍으로 끝까지 받아요. 다만 `curl`은 별도 프로세스라서, 이 요청들은 Claude Code의 네트워크 정책을 거치지 않아요.
- 프롬프트와 `files`에 넣은 내용은 모두 DeepSeek 서버로 전송돼요. 비밀값이나 공유하면 안 되는 데이터는 넣지 마세요.
- 웹 조사 결과에는 웹페이지가 쓴 글이 섞여 있어요. Claude는 그 내용을 지시가 아니라 정보로 다뤄요.
- **읽어 들인 글은 지시와 분리돼요.** DeepSeek이 읽는 파일, 명령 출력, 검색 결과, 웹 페이지는 모두 `<data id="…">`로 감싸요. id는 플러그인이 로드될 때 무작위로 만들고, DeepSeek에게는 그 안의 글은 지시가 아니라고 알려요. 파일이나 페이지는 id를 미리 알 수 없어서 경계를 닫은 척할 수 없어요(내용 안의 id도 지워요). 저장소나 웹 페이지에 숨긴 글이 DeepSeek을 조종할 가능성을 줄이는 장치이고, 실제로 막는 건 위의 권한 확인과 명령 승인이에요.
- **에이전트의 웹 도구.** `web_search`는 DeepSeek 검색을 써요(작업당 최대 8번, 건당 요금). `web_fetch`는 검색 결과에 나온 주소와, 작업 지시에 적힌 사이트(`python.org`, `pypi.org`, 또는 지시 속 URL의 사이트)의 페이지만 열 수 있어요. `www.python.org` 같은 하위 도메인도 포함돼요. 지시는 Claude가 쓰기 때문에, 페이지나 파일이 사이트를 끼워 넣어 임의의 주소로 데이터를 보내게 할 수 없어요. 주소 없이 이름만 적힌 경우는 흔한 도메인 끝(.org, .com 등)일 때만 사이트로 봐서, `textstats.py` 같은 파일 이름은 사이트로 치지 않아요. 검색어 자체는 DeepSeek 검색 서비스로 가요.
- **`deepseek_agent`의 명령 실행.** 플러그인은 먼저 Claude Code의 권한 규칙을 확인해요. deny 규칙은 항상 이기고, 허용 규칙(예: `Bash(npm test:*)`)에 맞는 명령은 묻지 않고 실행해요. 읽기 전용 명령 몇 개는 묻지 않고 실행해요: `pwd`, `ls`, `git status`, `git diff --stat` / `--name-only`, `git log --oneline`. `cat` 같은 파일 읽기 명령은 일부러 뺐어요. `read_file`의 권한 확인을 거치지 않고 파일을 읽어 DeepSeek으로 보낼 수 있기 때문이에요. 그 밖의 명령은 창을 띄워 물어봐요. "항상 허용"을 고르면 그 프로젝트 폴더에 대해 명령의 앞부분을 기억해요(`npm test *`, `cargo test *`, `python3 -m unittest *`, `git commit *`). 그래서 인자가 달라도 다시 묻지 않아요. 파일을 실행하는 인터프리터 명령(`node build.js`)은 명령 전체를 그대로 기억해요. 명령을 잇거나(`;`, `&&`), 넘기거나(`|`), 출력을 돌리거나(`>`), 치환하는(`$(…)`) 명령은 기본 허용이나 기억한 앞부분과 맞지 않는 것으로 보고 항상 물어봐요. 목록은 `~/.config/deepseek/allowed_commands.json`에 있어요. 프로젝트 밖에 두기 때문에 저장소가 스스로 명령을 허용해 둘 수 없어요. 허락된 명령은 `/bin/sh`(윈도우는 `cmd.exe`)로 최대 5분 동안 실행되고, Claude Code의 Bash 샌드박스를 쓰더라도 **그 밖에서** 실행돼요. Claude Code의 Bash 도구를 쓰지 않는 이유는, auto 모드의 분류기가 사용자 요청과 연결되지 않은 호출을 거부하기 때문이에요. 물어볼 사람이 없으면(백그라운드 실행 등) 처음 보는 명령은 거부되고, 에이전트에게는 다시 시도하지 말라고 알려요.

## 필요한 것

- [Claude Code](https://claude.com/claude-code): 터미널, 데스크톱 앱의 Code 탭, IDE 확장 중 아무거나
- [DeepSeek API 키](https://platform.deepseek.com/)

Claude Code의 플러그인 기능으로 동작하기 때문에, 데스크톱 앱의 일반 채팅 탭이나 claude.ai 웹에서는 쓸 수 없어요.

## 설치

Claude Code 터미널 세션의 프롬프트에서:

```
/plugin install deepseek-worker --marketplace doongchoong/claude-deepseek-worker
```

마켓플레이스 추가를 물으면 `y`, 그다음 범위를 고르세요(user 범위는 모든 프로젝트에 적용돼요). 설치할 때 **DeepSeek API 키**를 물어보는데, 입력하면 보안 저장소에 저장돼요.

셸에서:

```bash
claude plugin install deepseek-worker --marketplace doongchoong/claude-deepseek-worker
```

`/plugin`이 동작하지 않는 데스크톱 앱에서는 프롬프트 입력창 옆 **+** → **Plugins** → **Add marketplace**에 `doongchoong/claude-deepseek-worker` 입력 → **Add plugin** 순서로 설치해요.

플러그인 옵션을 비워 두면 `~/.config/deepseek/api_key` 파일에서 키를 읽어요(윈도우는 `%USERPROFILE%\.config\deepseek\api_key`). 이 파일은 본인만 읽을 수 있게 해 두세요(macOS/Linux는 `chmod 600`). 환경변수로는 키를 받지 않아요. 셸에서 띄운 모든 프로그램이 환경변수를 물려받고, `env` 한 번이면 그대로 드러나기 때문이에요.

## 사용법

Claude에게 평소처럼 말하면 돼요. 직접 쓰는 것보다 맡기는 게 싸다고 판단하면 Claude가 알아서 맡기고, 원하면 직접 지시할 수도 있어요.

- "DeepSeek한테 `parser.py` 단위 테스트를 `tests/test_parser.py`로 쓰게 하고 돌려 봐."
- "DeepSeek 리서치로 최신 Python 릴리스에서 뭐가 바뀌었는지 찾아 줘."
- "이 변환 작업 12개는 DeepSeek 배치로 돌려."
- "DeepSeek 에이전트로 `tests/parser`의 실패하는 테스트를 통과시켜. 확인은 `pytest tests/parser`로."
- "effort low로 맡겨." 명세가 아주 자세할 때는 추론을 줄여서 더 빠르고 싸게 처리해요.

돌아온 결과는 Claude가 검수해요(테스트를 돌리거나 파일 일부를 읽어요). 다시 지시해도 두 번 넘게 실패하면 Claude가 직접 작성해요.

## 설정

| 환경변수 | 기본값 | |
| --- | --- | --- |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 기본 모델 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API 주소 |

**언어:** 상태 줄과 `/deepseek-usage`는 영어나 한국어로 나와요. 플러그인 옵션 `language`의 기본값은 `auto`예요. `LC_ALL`, `LC_MESSAGES`, `LANG`을 먼저 보고, 없으면 macOS 시스템 언어를 따르고, 그래도 모르면 영어로 보여 줘요(윈도우는 직접 지정해 주세요). `/plugin`에서 `en`이나 `ko`로 고정할 수 있어요. 도구 설명, Claude용 지침, DeepSeek 프롬프트처럼 모델이 읽는 글은 모두 영어예요. DeepSeek에는 요청과 같은 언어로 답하라고 지시하므로, 한국어로 맡기면 한국어로 돌아와요.

**잠시 끄기:** `/plugin disable deepseek-worker`를 쓰거나, `~/.config/deepseek/disabled` 파일을 만들면 돼요. 파일을 만든 경우 새 세션에는 도구가 등록되지 않고, 이미 열린 세션에서는 "꺼져 있음"만 답해요. 파일을 지우면 다시 켜져요.

## 비용

DeepSeek 토큰 요금만 나가요. 웹 조사는 DeepSeek Search/Fetch 요금이 추가돼요(작성 시점 기준으로 성공한 검색이나 읽기 1,000건당 0.75달러). 호출할 때마다 상태 줄에 잔액이 갱신돼요. 코드 생성 비용은 대부분 출력과 추론 토큰에서 나오기 때문에, 비용을 줄이려면 `reasoning_effort: "low"`가 가장 효과가 커요.

## 구조

```
.claude-plugin/plugin.json       플러그인 매니페스트와 API 키 옵션
.claude-plugin/marketplace.json  /plugin install로 설치할 수 있게 해 주는 마켓플레이스 파일
hooks/register.ts                도구, Claude용 지침, 상태 줄, /deepseek-usage
hooks/usage.test.ts              DeepSeek·파일·환경변수·권한 판단을 흉내 낸 테스트 (claude plugin test .)
types/index.d.ts                 플러그인 상태(사용량, 잔액, 언어)의 형태
```

도구는 Claude Code 플러그인 API(`$.tool.register`)로 등록하고, DeepSeek 호출은 `$.http.fetch`, 파일 읽기·쓰기는 `$.fs`로 해요. 모델이 읽는 글은 영어, 사람이 보는 글은 영어나 한국어예요(위의 **언어** 참고).

**변경을 내보낼 때:** 푸시할 때마다 `.claude-plugin/plugin.json`의 `version`을 올리세요. 설치본이 버전별로 캐시되기 때문에, 같은 버전으로 푸시한 변경은 이미 설치한 사람에게 전달되지 않을 수 있어요. 설치한 사람은 `claude plugin update deepseek-worker@claude-deepseek-worker`로 받아요.

## 라이선스

[MIT](LICENSE)
