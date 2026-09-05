import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  ActivityComponent,
  makeActivityPresentation,
  type ActivityPresentation,
} from "../activity/component.ts";
import type { ActivityRow } from "../activity/model.ts";
import {
  ACTIVITY_DISCOVER,
  ACTIVITY_EVENT,
  ACTIVITY_HOST,
  type ActivityEnvelope,
  type ActivityEvents,
  type ActivityProviderOptions,
} from "../activity/protocol.ts";
import {
  ActivityError,
  type ActivityActionRequest,
  type ActivityServiceContract,
} from "../activity/service.ts";
import { renderActivityWidget } from "../activity/widget.ts";
import { fullScreenKeybindingLabel } from "../manager/key-labels.ts";

const EnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  providerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  operation: Schema.Literals(["register", "publish", "revoke"]),
  token: Schema.ObjectKeyword,
  hostToken: Schema.ObjectKeyword,
  items: Schema.optional(Schema.Unknown),
  starting: Schema.optional(Schema.Unknown),
  invoke: Schema.optional(
    Schema.declare<ActivityProviderOptions["invoke"]>(
      (value): value is ActivityProviderOptions["invoke"] => Predicate.isFunction(value),
    ),
  ),
  getDetail: Schema.optional(
    Schema.declare<NonNullable<ActivityProviderOptions["getDetail"]>>(
      (value): value is NonNullable<ActivityProviderOptions["getDetail"]> =>
        Predicate.isFunction(value),
    ),
  ),
  acknowledge: Schema.optional(
    Schema.declare<(available: boolean) => void>((value): value is (available: boolean) => void =>
      Predicate.isFunction(value),
    ),
  ),
});
const DiscoverySchema = Schema.Struct({ version: Schema.Literal(1), sessionId: Schema.String });
const safe = (run: () => void): void => {
  try {
    run();
  } catch {
    /* Host callbacks are best effort. */
  }
};
const neutral = () => ({ render: () => [], invalidate() {} });
interface Binding {
  readonly service: ActivityServiceContract;
  readonly rows: MutableRef.MutableRef<readonly ActivityRow[]>;
  readonly now: MutableRef.MutableRef<number>;
  readonly starting: MutableRef.MutableRef<number>;
  readonly presentation: ActivityPresentation;
  readonly nonce: object;
  readonly cleanups: Array<() => void>;
  active: boolean;
  installed: boolean;
  ctx?: ExtensionContext;
  sessionId?: string;
  render: () => void;
  close: () => void;
  manager: object | undefined;
}
export interface ActivityHost {
  readonly bind: (service: ActivityServiceContract) => () => void;
  readonly publish: (
    service: ActivityServiceContract,
    rows: readonly ActivityRow[],
    starting?: number,
  ) => void;
  readonly tick: (service: ActivityServiceContract, now: number) => void;
  readonly activate: (ctx: ExtensionContext, service: ActivityServiceContract) => void;
  readonly deactivate: () => void;
  readonly open: (ctx: ExtensionContext) => Effect.Effect<void, ActivityError>;
}

/** Pi callback/Promise and Effect submission boundary. The session service owns binding release. */
export function makeActivityHost(
  pi: ExtensionAPI,
  submit: (effect: Effect.Effect<void, ActivityError>, signal?: AbortSignal) => void,
): ActivityHost {
  const bindings = new Map<ActivityServiceContract, Binding>();
  let current: Binding | undefined;
  const announce = (binding: Binding) =>
    safe(() =>
      pi.events.emit(ACTIVITY_HOST, {
        version: 1,
        sessionId: binding.sessionId,
        hostToken: binding.nonce,
        available: binding.active && binding.installed,
      }),
    );
  const release = (binding: Binding) => {
    binding.active = false;
    if (current === binding) announce(binding);
    for (const cleanup of binding.cleanups.splice(0)) safe(cleanup);
    safe(binding.close);
    if (current === binding) {
      current = undefined;
      safe(() => binding.ctx?.ui.setWidget("cosmic-activity", undefined));
    }
    binding.installed = false;
    binding.render = () => undefined;
  };
  return {
    bind(service) {
      const binding: Binding = {
        service,
        rows: MutableRef.make([]),
        starting: MutableRef.make(0),
        now: MutableRef.make(0),
        presentation: makeActivityPresentation(),
        nonce: {},
        cleanups: [],
        active: false,
        installed: false,
        render: () => undefined,
        close: () => undefined,
        manager: undefined,
      };
      bindings.set(service, binding);
      return () => {
        release(binding);
        bindings.delete(service);
      };
    },
    publish(service, rows, starting = 0) {
      const binding = bindings.get(service);
      if (!binding) return;
      MutableRef.set(binding.rows, rows);
      MutableRef.set(binding.starting, starting);
      if (binding.active) safe(binding.render);
    },
    tick(service, now) {
      const binding = bindings.get(service);
      if (!binding) return;
      MutableRef.set(binding.now, now);
      if (
        binding.active &&
        (MutableRef.get(binding.rows).length || MutableRef.get(binding.starting) > 0)
      )
        safe(binding.render);
    },
    activate(ctx, service) {
      const binding = bindings.get(service);
      if (!binding || ctx.mode !== "tui") return;
      if (current) release(current);
      current = binding;
      binding.ctx = ctx;
      binding.sessionId = ctx.sessionManager.getSessionId();
      binding.active = true;
      const accept: Parameters<ActivityEvents["on"]>[1] = (data) => {
        try {
          if (
            !binding.active ||
            !binding.installed ||
            current !== binding ||
            !Schema.is(EnvelopeSchema)(data) ||
            data.sessionId !== binding.sessionId ||
            data.hostToken !== binding.nonce
          )
            return;
          if (data.operation === "register" && (!data.invoke || !data.acknowledge)) return;
          const acknowledge = data.acknowledge;
          const event: ActivityEnvelope = {
            version: data.version,
            sessionId: data.sessionId,
            providerId: data.providerId,
            token: data.token,
            hostToken: data.hostToken,
            operation: data.operation,
            items: data.items,
            starting: data.starting,
          };
          if (data.invoke) Object.assign(event, { invoke: data.invoke });
          if (data.getDetail) Object.assign(event, { getDetail: data.getDetail });
          if (acknowledge)
            Object.assign(event, {
              acknowledge: (available: boolean) =>
                safe(() => {
                  if (binding.active && current === binding)
                    acknowledge(available && binding.installed);
                }),
            });
          submit(
            Effect.suspend(() =>
              binding.active && binding.installed && current === binding
                ? service.receive(event)
                : Effect.void,
            ),
          );
        } catch {
          /* Malformed envelopes never reach the service. */
        }
      };
      safe(() => binding.cleanups.push(pi.events.on(ACTIVITY_EVENT, accept)));
      safe(() =>
        binding.cleanups.push(
          pi.events.on(ACTIVITY_DISCOVER, (data) =>
            safe(() => {
              if (Schema.is(DiscoverySchema)(data) && data.sessionId === binding.sessionId)
                announce(binding);
            }),
          ),
        ),
      );
      let returned = false;
      let mounted = false;
      let disposed = false;
      const acknowledgeInstall = () => {
        if (!returned || !mounted || disposed || !binding.active || current !== binding) return;
        binding.installed = true;
        announce(binding);
      };
      try {
        ctx.ui.setWidget(
          "cosmic-activity",
          (tui, theme) => {
            if (!binding.active || current !== binding || disposed) return neutral();
            binding.render = () => tui.requestRender();
            mounted = true;
            acknowledgeInstall();
            return {
              render: (width) =>
                binding.active && binding.installed
                  ? renderActivityWidget(MutableRef.get(binding.rows), width, 8, {
                      starting: MutableRef.get(binding.starting),
                      theme,
                      now: MutableRef.get(binding.now),
                      collapsed: binding.presentation.collapsed,
                    })
                  : [],
              invalidate() {},
              dispose() {
                disposed = true;
                if (current === binding) {
                  binding.installed = false;
                  announce(binding);
                }
              },
            };
          },
          { placement: "aboveEditor" },
        );
        returned = true;
        acknowledgeInstall();
      } catch {
        disposed = true;
        binding.installed = false;
        announce(binding);
      }
    },
    deactivate() {
      if (current) release(current);
    },
    open: (ctx) =>
      Effect.gen(function* () {
        const binding = current;
        if (
          !binding?.active ||
          !binding.installed ||
          binding.manager ||
          ctx.mode !== "tui" ||
          ctx.sessionManager.getSessionId() !== binding.sessionId
        )
          return;
        const owner = {};
        binding.manager = owner;
        const previousRender = binding.render;
        let closing = false;
        let factoryInvoked = false;
        let doneInvoked = false;
        let requested: { readonly action: ActivityActionRequest | undefined } | undefined;
        let hostDone: ((action: ActivityActionRequest | undefined) => void) | undefined;
        let hostTui: TUI | undefined;
        let overlay: OverlayHandle | undefined;
        let rejectCompletion: (() => void) | undefined;
        let detailController: AbortController | undefined;
        const finish = (action?: ActivityActionRequest) => {
          requested ??= { action };
          if (doneInvoked || !hostDone || !hostTui || !overlay) return;
          doneInvoked = true;
          try {
            // Pi 0.85 done pops globally. The owned guard protects a newer questionnaire overlay.
            overlay.hide();
            const guard = hostTui.showOverlay(neutral(), { nonCapturing: true });
            try {
              hostDone(requested.action);
            } finally {
              guard.hide();
            }
          } catch {
            rejectCompletion?.();
          }
        };
        const close = () => {
          closing = true;
          safe(() => detailController?.abort());
          finish();
        };
        binding.close = close;
        const action = yield* Effect.callback<ActivityActionRequest | undefined, ActivityError>(
          (resume) => {
            const fail = () => resume(Effect.fail(new ActivityError({ reason: "failed" })));
            rejectCompletion = fail;
            try {
              ctx.ui
                .custom<ActivityActionRequest | undefined>(
                  (tui, theme, keybindings, done) => {
                    if (factoryInvoked) {
                      close();
                      return neutral();
                    }
                    factoryInvoked = true;
                    hostDone = done;
                    hostTui = tui;
                    if (
                      closing ||
                      !binding.active ||
                      current !== binding ||
                      binding.manager !== owner
                    ) {
                      close();
                      return neutral();
                    }
                    binding.render = () => {
                      previousRender();
                      tui.requestRender();
                    };
                    return new ActivityComponent({
                      snapshot: () => MutableRef.get(binding.rows),
                      starting: () => MutableRef.get(binding.starting),
                      presentation: binding.presentation,
                      theme,
                      now: () => MutableRef.get(binding.now),
                      height: () => Math.max(1, tui.terminal.rows - 2),
                      close: (result) => {
                        if (!closing) finish(result);
                      },
                      requestRender: () => tui.requestRender(),
                      matchesKeybinding: (data, id) => keybindings.matches(data, id),
                      keybindingLabel: (id, fallback) =>
                        fullScreenKeybindingLabel(
                          id,
                          fallback,
                          Predicate.isFunction(keybindings.getKeys)
                            ? (key) => keybindings.getKeys(key)
                            : undefined,
                        ),
                      loadDetail: (request, deliver) => {
                        safe(() => detailController?.abort());
                        if (closing) return;
                        const controller = new AbortController();
                        detailController = controller;
                        submit(
                          serviceDetail(binding.service, request, (text) => {
                            if (
                              !controller.signal.aborted &&
                              !closing &&
                              current === binding &&
                              binding.manager === owner
                            )
                              deliver(text);
                          }),
                          controller.signal,
                        );
                      },
                    });
                  },
                  {
                    overlay: true,
                    overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
                    onHandle: (handle) => {
                      overlay = handle;
                      if (closing || requested) finish(requested?.action);
                    },
                  },
                )
                .then((result) => resume(Effect.succeed(result)), fail);
            } catch {
              fail();
            }
          },
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              close();
              if (binding.manager === owner) {
                binding.manager = undefined;
                binding.close = () => undefined;
                binding.render = previousRender;
                if (binding.active) safe(binding.render);
              }
            }),
          ),
        );
        if (action && binding.active && current === binding)
          yield* binding.service
            .invoke(action)
            .pipe(
              Effect.tapError(() =>
                Effect.sync(() =>
                  safe(() => ctx.ui.notify("Activity action is no longer available.", "warning")),
                ),
              ),
            );
      }),
  };
}
const serviceDetail = (
  service: ActivityServiceContract,
  request: Parameters<ActivityServiceContract["detail"]>[0],
  deliver: (text: string) => void,
) =>
  service.detail(request).pipe(
    Effect.match({
      onSuccess: (text) => safe(() => deliver(text)),
      onFailure: () => safe(() => deliver("Details unavailable. The item may have changed.")),
    }),
  );
