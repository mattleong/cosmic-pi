# Architecture

`pi-intercom` lets the main agents of live Pi sessions owned by the same OS user on one machine
reach each other. Each reachable session runtime publishes a private registry record naming its
socket and token; other sessions discover peers by listing those records and message them over
that socket. There is no mailbox: a message is delivered when it is sent or refused. Messaging
among the agents of one session belongs to pi-subagents' `agent_*` tools.

## Ownership and boundaries

- [Application](src/application.ts) registers Pi events, the inbound message renderer, the
  `/intercom` command, and replay at factory time, owns the session-runtime slot, and registers
  the tools once a runtime is active. [Layer composition](src/layer.ts) supplies the registry and
  session services.
- [Host session](src/boundary/host-session.ts) decides whether a session is reachable and
  captures its identity: only `tui` and `rpc` sessions register. Subagent child processes,
  recognized by core's `isSubagentChildProcess`, register no handlers, tools, or commands at all.
- [Session service](src/session/service.ts) owns this runtime's record and listener from startup
  to disposal: a fresh 128-bit instance and 256-bit token per runtime, writes serialized behind
  one permit, and removal at disposal.
- [Server](src/transport/server.ts), [client](src/transport/client.ts), and
  [protocol](src/transport/protocol.ts) carry the RPCs between runtimes;
  [handshake](src/transport/handshake.ts) holds the token proofs and
  [connections](src/transport/connections.ts) bounds and orders what each peer connection may do.
  The server delegates every authenticated request to the injected `IntercomInbound` handler;
  [host inbound](src/boundary/host-inbound.ts) answers from the live host session.
- [Delivery](src/delivery.ts) owns how an inbound message reaches the session: the shared session
  wake, the wake budget, per-sender rate limits, the receive switch, and the message frame.
- [Tools](src/tools/register.ts) give main agents `session_list`, `session_send`, and
  `session_read`; [sessions](src/tools/sessions.ts) resolves peers from the registry and calls them
  through the client. [Command](src/command.ts) is `/intercom list` and `/intercom receive`.
- [Registry store](src/registry/store.ts) owns `<agentDir>/intercom` and this user's fallback
  socket namespace: private directories, atomic record replacement, listing, socket path
  reservation, and the sweep of dead owners. [Private files](src/registry/private-files.ts) are
  its no-follow file operations. [Schema](src/registry/schema.ts) describes the record and the
  fallback socket owner record.

## Registry

Records live at `<agentDir>/intercom/sessions/<instance>.json`. The managed directories,
`intercom`, `sessions`, and `s`, must be real directories of this user, never links; they are
created 0700 and tightened to 0700 when they already exist, and anything else fails the operation.
Records are 0600. A record is written to an exclusively created, no-follow temporary file, synced,
and committed by rename; nothing fallible follows the rename, and an uncommitted temporary file is
removed. Each record has exactly one writer, the runtime that generated its instance.

Session start sweeps dead owners, reserves the socket path, writes the record, and then
listens, so a crash after binding leaves a record naming the socket for the sweep. A name change
rewrites the record. Disposal closes the listener and removes its socket, then removes the
record while holding the write permit and retires the runtime, so a rewrite in progress finishes
first and none can follow. Replacing a session disposes the old runtime before the new one
registers under a new instance and token.

Listing reads up to 1,024 `<instance>.json` files without following links and skips, without
removing, files that are links, not regular, another user's, readable by others, oversized,
unreadable, malformed, or name another instance; it reports them with a reason. Files removed
after the directory read are skipped silently.

## Sweep and liveness

A record's owner is dead only on positive evidence from core's `processLiveness`: the PID is
gone, or a live PID started at a different time. Unknown liveness, including a record without a
comparable start identity, keeps the record. A dead record is claimed by renaming it to a
tombstone, so one concurrent sweeper retires it; the tombstone is read back and removed only when
it is still the record judged dead, together with its socket in the shared socket directory.
Otherwise it goes back unless its owner already wrote a new one. A tombstone left behind is
removed only when it decodes to a dead owner. Each sweep examines a bounded number of records and
directories for at most two seconds; the next sweep continues.

## Socket paths

The socket is `<agentDir>/intercom/s/<instance>.sock` when that path is at most 100 bytes, which
fits the macOS and Linux `sun_path` limits. Otherwise it is `intercom.sock` in a new 0700
directory named for the instance inside `<fallbackRoot>/pi-intercom-<uid>`, this user's private
namespace (`/tmp` in a live session), beside a 0600 owner record; disposal removes the socket, the
owner record, and then the emptied directory. A namespace that is a link or another user's
directory is refused, so another user can at most deny the fallback.

Sweeps look only inside this user's namespace, never at other names in `/tmp`. A directory there
is reclaimed only when it is a real directory of this user named for an instance and either its
owner record, read without following links and bounded in size, names that instance and a dead
owner, or it has no owner record and nothing in it changed for a day. A claim renames it to a
tombstone and checks that the tombstone is the same directory with the same evidence; clearing
removes only the socket, the owner record (last), and its temporary writes, and leaves the
directory when anything else is in it. The runtime reserves only the path: a generated socket
name is not ownership of a file.

## Transport

Each runtime serves effect/rpc over its own Unix socket with newline-delimited JSON framing from
core: every frame, complete or buffered, is bounded, and an oversized frame closes the peer. The
socket is made 0600 as soon as it is bound. `Describe` returns the session's identity and idle or
busy state, `Deliver` hands a message to the handler and returns its disposition, and `ReadLast`
returns the latest assistant text.

Both ends prove they hold the token from the target's record before anything else crosses the
connection, and the token itself never does. The client opens with `Hello` and a fresh 256-bit
challenge; the server answers with its own challenge and an HMAC-SHA-256 under the token over
both challenges for the server role. Only when that proof checks does the client send
`Authenticate` with the HMAC for the client role; the server then admits `Describe`, `Deliver`, and
`ReadLast` on that connection alone. A listener that doesn't hold the token, such as a stale or
foreign listener at the recorded path, learns no token and no request, and its answers are
rejected. A failed client proof is refused as unauthorized and the connection admits nothing more.
The client never reconnects, so every request and answer travels on the authenticated
connection. Application frames after the handshake aren't authenticated, so an active relay of
the same user between the two ends could read or alter them; the handshake stops impostor
listeners, not relays. Trusted private ancestor directories are assumed. Same-user processes can
read records, so this authenticates a runtime, not a user; see Delivery for what the sender
identity means.

The server bounds what peers can hold: at most 32 connections, a 2-second deadline to
authenticate, a 10-second idle deadline, four requests in flight per connection, and a bounded
write backlog; it handles at most 64 requests at once across all peers. A request out of
handshake order, over a bound, or malformed closes its connection.

A listen never takes over a bound path. Each client call opens its own connection under a
deadline and fails with a typed reason: unreachable (no listener, or the connection failed before
the request went out), unauthorized, disconnected (the connection ended before the answer),
timeout, or protocol. Only unreachable and unauthorized prove the recipient handled nothing;
after any other failure a `Deliver` may have been delivered. Host reads run only while the runtime
still holds the session slot, in the same synchronous callback; a retired runtime answers
`session_unavailable`. Telemetry stays free of message text, tokens, paths, and identities: RPC
tracing is off on both ends, and delivery logs carry only the disposition or refusal code.

## Delivery

An inbound message passes, in one synchronous host callback: the runtime still holds the session
slot (else `session_unavailable`), receiving is on (`session_receive_disabled`), and the session's
limits allow it (`session_rate_limited`): at most 10 messages a minute per sender, 30 messages and
256 KiB of framed text a minute from all senders together, and 20 held messages waiting for a
turn. It is then sent as
a displayed `pi-intercom-message` custom message whose details name the advisory sender and message
id, with the slot rechecked beside `sendMessage`. Core's `registerSessionWake` decides the
disposition: an idle session is `woken`, a busy one `queued` and continued at settle, and a session
with a dialog open or interrupted by its user `held`, appended without a turn until the dialog
closes or the user prompts again. Core checks a wake budget before every turn it starts or
continues, including the wake after a dialog closes: once messages have started or continued three
turns within one user prompt, further messages are held until the next one; messages joining a
continuation already owed count once. Receiving and the budget reset with each session start; nothing is persisted.
The frame tells the model the message comes from another agent session, not its user.

## Tools and command

The tools register only for main agents of reachable sessions; subagent children never load the
package. That keeps cross-session messaging a main-agent capability by design, not a security
boundary: any process of the same OS user, a subagent's shell included, can read the records and
complete the handshake. A peer is a registry record of another runtime whose owner isn't known to be dead,
addressed by session id; a duplicated id is refused as `session_ambiguous`, an unknown one as
`session_not_found`. Listing describes every record under the short `Describe` deadline and marks
silent ones unresponsive. Owner liveness can spawn `ps`, so it is checked only for a record that
didn't answer, and a silent record whose owner is dead is skipped. A send that times out or loses its connection reports an uncertain
outcome and tells the model not to resend. `session_send` is model-only; list and read return
`pi-intercom/session` structured results to codemode scripts. Refusals are error results with a
compact issue; the agent's procedure stays in the expanded detail. Replay is anchored to
`/intercom`, whose `receive on|off` flips the per-session receive switch.

## Tests

[Registry tests](tests/registry.test.ts) cover private atomic writes, refused links and unsafe
records, listing diagnostics, the evidence-based sweep, and socket path reservation.
[Transport tests](tests/transport.test.ts) cover the handshake against rogue listeners, connection
bounds, stale sockets, oversized frames, deadlines, shutdown, and telemetry over real sockets. [Application tests](tests/application.test.ts) cover registration modes, the child
marker, rewrites, replacement, removal, and peers reaching live sessions.
[Delivery tests](tests/delivery.test.ts) cover dispositions, holds, retirement, the wake budget,
rate limits, and the receive switch. [Tool tests](tests/tools.test.ts) cover listing, sends
between two runtimes, reads, refusals, uncertainty, and issue wording;
[telemetry tests](tests/telemetry.test.ts) keep content out of logs and spans. User-facing
behavior is in the [README](README.md).
