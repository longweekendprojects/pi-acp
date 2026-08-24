# pi-acp

Use [pi](https://github.com/earendil-works/pi-coding-agent) as an agent inside any editor or app that speaks the [Agent Client Protocol](https://agentclientprotocol.com), including [Buzz](https://github.com/block/buzz) and Zed. Your pi configuration comes with it: your models, your skills, your subagents, and whatever `AGENTS.md` governs the working directory.

ACP clients expect to launch an agent and talk to it over stdio. pi has its own JSONL protocol instead, so the two cannot see each other. This adapter sits between them and translates in both directions.

## Quick start

```bash
npm install -g pi-acp
```

Then point your ACP client at the `pi-acp` command. In Zed, add it to `agent_servers` in your settings:

```json
{
  "agent_servers": {
    "pi": { "command": "pi-acp", "args": [] }
  }
}
```

In Buzz, drop a harness definition at
`~/Library/Application Support/xyz.block.buzz.app/custom_harnesses/pi.json`:

```json
{
  "id": "pi",
  "label": "pi",
  "acpCommand": "pi-acp",
  "agentCommand": "pi",
  "env": {},
  "installInstructionsUrl": "https://github.com/longweekendprojects/pi-acp",
  "installHint": "Buzz talks to pi through the pi-acp adapter. Install it with: npm install -g pi-acp."
}
```

Restart the app and pi appears alongside the harnesses that ship with it.

Importing an `.agent.json` does not carry the harness choice with it, so a freshly imported agent shows `Harness: Not configured` and quietly falls back to Buzz's own agent. Buzz identifies a harness by its `id`, which the agent record stores in `agent_command`, while `acp_command` holds the binary to spawn. Quit Buzz, set `agent_command` to `pi` and `acp_command` to `pi-acp` for your agent in
`~/Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json`, then start Buzz again.

`pi` must already be installed and working on its own. The adapter runs whatever `pi` your PATH resolves, so if `pi` starts in a terminal, it starts here.

## Configuration

Everything is optional. Without any of it, the adapter runs plain `pi` and lets pi's own configuration decide.

| Variable | Meaning |
|---|---|
| `PI_ACP_PI_BIN` | Path to the pi binary. Defaults to `pi` on PATH. |
| `PI_ACP_MODEL` | Model passed to pi as `--model`. |
| `PI_ACP_PROVIDER` | Provider passed to pi as `--provider`. |
| `PI_ACP_CWD` | Fallback working directory when the client does not supply one. |
| `BUZZ_AGENT_MODEL` | Same as `PI_ACP_MODEL`. Buzz sets this from the agent's model field. |
| `BUZZ_AGENT_PROVIDER` | Same as `PI_ACP_PROVIDER`. |
| `PI_ACP_THINKING` | Reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `BUZZ_AGENT_THINKING_EFFORT` | Same as `PI_ACP_THINKING`. |

Set these in the harness definition's `env` block to pin a default for every agent using the harness. The model string may also carry the level directly, as in `anthropic/claude-sonnet-4-20250514:high`. Use whatever ids your own pi configuration enables; leave `env` empty to let pi decide. Buzz's own Model dropdown reports `Harness default` because the adapter does not yet advertise `configOptions`, so the environment is currently the only place model choice takes effect.

The working directory matters more than any of these. pi reads `AGENTS.md`, skills, and project settings relative to it, so an agent pointed at a repository inherits that repository's instructions.

Leave the client's own system prompt or persona field empty. The adapter deliberately does not forward it, because pi already has instructions of its own: your global rules, the working directory's `AGENTS.md`, and every skill you have installed. A second prompt layered on top competes with those rather than adding to them. Put behavior in pi's configuration, where the rest of your setup already lives.

## What comes across

Assistant text and reasoning stream as they are produced. Tool calls appear as they start and update when they finish, tagged with an ACP tool kind so clients render the right icon. Images in a prompt are forwarded to pi. Cancelling a turn aborts the pi run.

Session history does not persist across restarts. Each ACP session gets a fresh pi process, and `loadSession` is not implemented, so a client that reconnects starts a new conversation. pi still writes its own session file, which you can resume from a terminal with the path pi prints on exit.

## Development

```bash
git clone https://github.com/longweekendprojects/pi-acp
cd pi-acp
npm install
npm link
```

`test/smoke.js` drives the adapter the way a client does and prints everything that comes back:

```bash
node test/smoke.js /path/to/repo "Reply with exactly: pong"
```

It exits non-zero if no assistant text arrives, which makes it usable as a health check after changing the event mapping.

### How it works

One adapter process can hold many ACP sessions. Each `session/new` spawns a pi child in the session's working directory and keeps it alive for the life of the session. Each `session/prompt` flattens the client's content blocks into a single pi `prompt` command, then forwards pi's event stream as ACP `session/update` notifications until pi emits `agent_settled`, which resolves the turn.

The translation table is small and lives in `src/index.js`:

| pi event | ACP session update |
|---|---|
| `message_update` / `text_delta` | `agent_message_chunk` |
| `message_update` / `thinking_delta` | `agent_thought_chunk` |
| `tool_execution_start` | `tool_call` (status `in_progress`) |
| `tool_execution_end` | `tool_call_update` (status `completed` or `failed`) |
| `agent_settled` | resolves the turn with a stop reason |

Diagnostics go to stderr, never stdout, because stdout carries the ACP stream. On shutdown the adapter closes each pi child's stdin and waits for it to exit before leaving, so pi's parting writes land in a live pipe rather than raising `EPIPE`.

## Contributing

Issues and pull requests are welcome. The most useful additions are `loadSession` support so conversations survive a client restart, richer tool-call content such as diffs for edits, and permission passthrough so a client can approve tool calls instead of relying on pi's own policy.

## License

MIT
