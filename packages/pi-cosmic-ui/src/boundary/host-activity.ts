import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
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
  ActivityEnvelopeSchema,
  type ActivityEnvelope,
  type ActivityEvents,
} from "../activity/protocol.ts";
import {
  ActivityError,
  type ActivityActionRequest,
  type ActivityServiceContract,
} from "../activity/service.ts";
import { renderActivityWidget } from "../activity/widget.ts";
import { fullScreenKeybindingOptions } from "../manager/key-labels.ts";
import { openOwnedSurface } from "./host-surface.ts";

const DiscoverySchema = Schema.Struct({ version: Schema.Literal(1), sessionId: Schema.String });
/** Host callbacks are best effort. */
const safe = (run: () => void): void => invokeHostCallback(run, undefined);
const neutral = () => ({ render: () => [], invalidate() {} });
interface Binding {
  readonly service: ActivityServiceContract;
  rows: readonly ActivityRow[];
  now: number;
  starting: number;
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
        rows: [],
        starting: 0,
        now: 0,
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
      binding.rows = rows;
      binding.starting = starting;
      if (binding.active) safe(binding.render);
    },
    tick(service, now) {
      const binding = bindings.get(service);
      if (!binding) return;
      binding.now = now;
      if (binding.active && (binding.rows.length || binding.starting > 0)) safe(binding.render);
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
            !Schema.is(ActivityEnvelopeSchema)(data) ||
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
                  ? renderActivityWidget(binding.rows, width, 8, {
                      starting: binding.starting,
                      theme,
                      now: binding.now,
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
        let detailController: AbortController | undefined;
        const action = yield* openOwnedSurface<ActivityActionRequest | undefined>(ctx, {
          placement: "screen",
          closedValue: undefined,
          isCurrent: () => binding.active && current === binding && binding.manager === owner,
          onControl: (close) => {
            binding.close = close;
          },
          onClose: () => {
            closing = true;
            safe(() => detailController?.abort());
          },
          create: ({ tui, theme, keybindings, getHeight, finish }) => {
            binding.render = () => {
              previousRender();
              tui.requestRender();
            };
            return new ActivityComponent({
              snapshot: () => binding.rows,
              starting: () => binding.starting,
              presentation: binding.presentation,
              theme,
              now: () => binding.now,
              height: getHeight,
              close: finish,
              requestRender: () => tui.requestRender(),
              ...fullScreenKeybindingOptions(keybindings),
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
        }).pipe(
          Effect.mapError(() => new ActivityError({ reason: "failed" })),
          Effect.ensuring(
            Effect.sync(() => {
              if (binding.manager !== owner) return;
              binding.manager = undefined;
              binding.close = () => undefined;
              binding.render = previousRender;
              if (binding.active) safe(binding.render);
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
