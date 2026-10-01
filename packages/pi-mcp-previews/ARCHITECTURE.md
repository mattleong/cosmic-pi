# Architecture

`index.ts` loads the thin extension entrypoint. Installation is unconditional: there is no activation configuration. Native `createMcpExtension()` receives no options and remains the sole owner of MCP configuration, trust, authentication, transports, execution, permissions, result storage, and connection cleanup.

## Registration and ownership

`boundary/host-native-mcp.ts` invokes the public factory through an owning API. It buffers event and manager-command registrations, rejects unsupported eager registration, and forwards later native registrations. Buffer failure is atomic only before commit. Pi registration may mutate then throw; commit has no rollback API, and failed ownership gates stay closed.

`application/native-mcp-registration.ts` admits startup only when the sole public `/mcp` source matches the unique non-builtin `/mcp-previews` anchor. Commands recheck authority. After admission, other native events remain enabled despite late conflicts, and each native shutdown handler runs once per started session. Callback-time styling touches only new definitions; failures forward the original definition. No foreign registry definition is retrieved or mutated.

## Session presentation

`layer.ts` exposes only public `CodePreviewSchedulerService.layer`. `application/lifecycle.ts` owns one core session-runtime slot. Its startup loads public preview settings with captured CWD/trust and an Effect-owned abort signal before native startup registers tools. Activation publishes only current-token scheduling. Replacement and shutdown synchronously revoke the presentation flag before disposing scoped fibers. Settings or runtime failure reports presentation fallback without disabling the native manager.

`commands/register.ts` registers status/health only. `tools/` owns pure identity/evidence classification and synchronous rendering over public Code Previews and Cosmic UI seams. Resource action/subject helpers belong to Code Previews for shared standalone/nested vocabulary. Expanded content preserves full arguments, native output and saved-output evidence; Pi draws native images.

## Verification

Owned manager fixtures protect admission, precommit refusal, commit uncertainty, settings ordering, fail-open behavior, retirement, dynamic registration and exact-once shutdown. Public loader tests exercise default installation in both loader orders and obsolete settings. Public presentation harness tests exercise actual definitions, expansion, clipping, hostile content/themes and unchanged execution. The env-gated gallery contains only standalone native MCP states.
