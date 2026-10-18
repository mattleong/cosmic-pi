# pi-intercom

Lets the main agents of your live Pi sessions on this machine find and message each other, in any directory.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-intercom"
```

## Usage

Interactive (`tui`) and RPC sessions register automatically; print and JSON runs and subagent child processes never do. A registered session's main agent gets three tools; subagents get none.

| Tool           | Does                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `session_list` | Lists your other live sessions: session id, name, working directory, idle, busy, or unresponsive |
| `session_send` | Sends a message of up to 16,384 characters to another session's main agent, by session id        |
| `session_read` | Reads another session's latest assistant message (up to 32 KB) and whether it is busy            |

A message is delivered at once or not at all; nothing is stored for later. An idle recipient starts a turn to read it, and a busy one reads it when its current turn ends. The recipient holds incoming messages without acting on them while a dialog is open, after you interrupt it with Esc until your next prompt, and once messages have started or continued three of its turns since your last prompt. Each sending session may deliver ten messages a minute to a session. When a send times out or its connection drops, the message may still have arrived, and the agent is told not to resend it.

Codemode scripts can call `session_list` and `session_read`, which return structured `pi-intercom/session` results; only the agent itself can call `session_send`.

### Commands

| Command                       | Does                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/intercom list`              | Lists your other live sessions                                                                           |
| `/intercom receive [on\|off]` | Shows or sets whether other sessions can message this one; on by default and again for every new session |

### Trust

Messages arrive framed with the sender's session name, id, and working directory, and with a reminder that they come from another agent session, not from you. Any process running as your OS user can read the registry and connect, so the sender identity is advisory, and keeping the `session_*` tools from subagents doesn't stop a subagent, or anything else running as you, from sending. Turn receiving off in a session that shouldn't take requests from other agents.

## Registry

Each registered session runtime keeps one private record while it runs:

```text
~/.pi/agent/intercom/sessions/<instance>.json
```

```json
{
  "version": 1,
  "instance": "<128-bit hex>",
  "pid": 12345,
  "started": "<OS process start identity>",
  "sessionId": "<Pi session id>",
  "name": "<session name, when set>",
  "cwd": "/Users/example/work/project",
  "socket": "/Users/example/.pi/agent/intercom/s/<instance>.sock",
  "token": "<256-bit hex>"
}
```

The directories are 0700 and records and sockets 0600; a registry directory or record that is a link, belongs to another user, or is readable by others is refused. The token lets a caller and the session prove to each other that they read the same record, without the token itself crossing the socket, so treat records as secrets. A record is rewritten when you rename the session and removed when the session ends. Records left by crashed sessions are removed when another session starts. When the socket path under the agent directory would be too long for a Unix socket, the socket lives in a directory named for the instance inside `/tmp/pi-intercom-<uid>`, a private 0700 directory for your user.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
