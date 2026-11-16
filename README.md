# Clonvo CLI

Call [Clonvo](https://clonvo.com)'s tools from your terminal: web search, page reading, site maps and crawls, structured extraction, cited answers, research reports, a browser agent, code sandboxes, and company and people lookups. Sign in with your browser once, then every tool is a command.

```bash
npm install -g @clonvo/cli
clonvo login
clonvo web_search "durable objects vs queues" --max-results 3
```

Full docs: [clonvo.com/docs/cli](https://clonvo.com/docs/cli)

## Install

Needs Node.js 22 or later.

```bash
npm install -g @clonvo/cli
```

The command is `clonvo`. To run it without installing, use `npx @clonvo/cli`, as in `npx @clonvo/cli login`.

## Sign in

```bash
clonvo login
```

Your browser opens Clonvo. Pick the organization and project the CLI works in, and approve. Calls bill to that project and show up in Activity as **Clonvo CLI**. Tools need the Pay as you go plan or higher on Clonvo.

The sign-in is saved in `~/.config/clonvo/cli-credentials.json` (`%APPDATA%\clonvo` on Windows), readable only by you, and renews itself. `clonvo logout` signs out and disconnects this computer; you can also disconnect it in Clonvo under **Settings → Connected apps**.

In CI, on a server, or anywhere without a browser, set an API key instead. It wins over a saved sign-in:

```bash
export CLONVO_API_KEY="sk-cv-v1-…"
```

## Call a tool

```bash
clonvo tools                                   # what you can call
clonvo web_search --help                       # a tool's arguments
clonvo web_search "vector databases" --include-domains github.com --time-range month
clonvo web_scrape https://example.com
clonvo web_extract https://example.com/pricing --schema @schema.json
echo '{"query": "agent memory"}' | clonvo web_search --args -
```

Values without a flag fill the tool's required arguments in order. Every other argument is a flag, typed by the tool's JSON Schema: repeat a list flag to add items, and pass objects as JSON inline, from a file with `@`, or from standard input with `-`.

The result prints to standard output as JSON, ready for `jq`. In a terminal, one line on standard error shows the tool, the provider, the charge and the generation id. `--full` prints the whole response and `--compact` prints it on one line. `--provider clonvo` limits the call to the providers you name.

`web_crawl`, `web_research` and `browser_task` run as jobs. The CLI waits for them; Ctrl-C cancels the job. With `--no-wait` you get the job back at once and check it with `clonvo jobs get <id>`.

## Commands

| Command | What it does |
| --- | --- |
| `clonvo login` | Sign in with your browser |
| `clonvo login --with-key` | Save an API key instead (read from standard input) |
| `clonvo logout` | Sign out and disconnect this computer |
| `clonvo whoami` | How you're signed in, the plan and the balance |
| `clonvo balance` | The credit balance |
| `clonvo tools` | The tools you can call |
| `clonvo <tool> [args]` | Call a tool |
| `clonvo jobs get <id>` / `cancel <id>` | Read or cancel a long-running job |
| `clonvo completion bash\|zsh\|fish` | Print a shell completion script |
| `clonvo help [command\|tool]` | Help for a command or a tool |

Global flags: `--debug` logs each HTTP request to stderr (method, URL, status and time, never tokens or bodies), and `--no-color` turns color off. `NO_COLOR` and `FORCE_COLOR` work too.

Exit codes, as in `gh`: `0` success, `1` the call failed, `4` sign in first, `130` cancelled.

## Shell completion

Completes commands, tool names and each tool's flags. Tool names come from the last `clonvo tools` or tool call, so Tab never waits on the network.

```bash
echo 'eval "$(clonvo completion bash)"' >> ~/.bashrc
echo 'eval "$(clonvo completion zsh)"' >> ~/.zshrc     # after compinit
clonvo completion fish > ~/.config/fish/completions/clonvo.fish
```

## Updates and telemetry

Once a day, in an interactive terminal, the CLI asks the npm registry for the latest version and mentions it if there's a newer one. It never checks in CI, and `CLONVO_NO_UPDATE_NOTIFIER=1` turns it off. That request carries no information about you.

The CLI collects no telemetry. Your tool calls appear in your organization's Activity on Clonvo, as any API call does.

## How sign-in works

`clonvo login` is OAuth 2.1 with PKCE and a loopback redirect ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)). The CLI listens on `127.0.0.1` on a random port, opens `https://api.clonvo.com/oauth/authorize` with the public client id `clonvo-cli`, and exchanges the code it gets back for an access token and a refresh token, which it keeps in the credentials file above.

## Development

```bash
npm install
npm test
npm run build
CLONVO_API_KEY=… node dist/cli.js tools
```

Issues and pull requests are welcome. For account questions, write to support@clonvo.com.

## License

MIT
