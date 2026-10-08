import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback, notifyAtHostBoundary } from "pi-cosmic-core";
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
  type ActivityServiceOptions,
} from "../activity/service.ts";
import { renderActivityWidget } from "../activity/widget.ts";
import { activityWidgetHeight } from "../activity/widget-projection.ts";
import { fullScreenKeybindingOptions } from "../manager/key-labels.ts";
import { openOwnedSurface } from "./host-surface.ts";
import type { ActivitySection } from "../activity/view-protocol.ts";
import { installActivityView, type ActivityHostRun } from "./host-activity-view.ts";
import { inputDockVisible } from "./host-input-dock.ts";

/** Activity rows kept while an input dock needs the shared above-editor space. */
const COMPACT_WIDGET_ROWS = 3;

const isDiscovery = Schema.is(
  Schema.Struct({ version: Schema.Literal(1), sessionId: Schema.String }),
);
const MANAGER_TITLES = {
  workflows: "Activity",
  subagents: "Subagents",
  tasks: "Background tasks",
} satisfies Record<ActivitySection, string>;
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
  update: () => void;
  close: () => void;
  manager: object | undefined;
}
export interface ActivityHost {
  /** Hooks that bind one session's activity service to this host until it releases them. */
  readonly serviceOptions: () => Required<ActivityServiceOptions>;
  readonly activate: (ctx: ExtensionContext, service: ActivityServiceContract) => void;
  readonly deactivate: () => void;
  readonly open: (
    ctx: ExtensionContext,
    section?: ActivitySection,
  ) => Effect.Effect<boolean, ActivityError>;
}

/** Pi callback/Promise and Effect submission boundary. The session service owns binding release. */
export function makeActivityHost(
  pi: ExtensionAPI,
  submit: (effect: Effect.Effect<void, ActivityError>, signal?: AbortSignal) => void,
  run?: ActivityHostRun,
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
    binding.manager = undefined;
    if (current === binding) {
      current = undefined;
      safe(() => binding.ctx?.ui.setWidget("cosmic-activity", undefined));
    }
    binding.installed = false;
    binding.render = () => undefined;
    binding.update = () => undefined;
  };
  const host: ActivityHost = {
    serviceOptions() {
      let binding: Binding | undefined;
      return {
        publish: (rows, starting) => {
          if (!binding) return;
          binding.rows = rows;
          binding.starting = starting;
          if (binding.active) safe(binding.render);
        },
        changed: () => {
          if (binding?.active && current === binding) safe(binding.update);
        },
        tick: (now) => {
          if (!binding) return;
          binding.now = now;
          if (binding.active && (binding.rows.length || binding.starting > 0)) safe(binding.render);
        },
        connect: (service) => {
          const bound: Binding = {
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
            update: () => undefined,
            close: () => undefined,
            manager: undefined,
          };
          binding = bound;
          bindings.set(service, bound);
          return () => {
            release(bound);
            bindings.delete(service);
            if (binding === bound) binding = undefined;
          };
        },
      };
    },
    activate(ctx, service) {
      const binding = bindings.get(service);
      if (!binding || ctx.mode !== "tui") return;
      if (current) release(current);
      current = binding;
      binding.ctx = ctx;
      binding.sessionId = ctx.sessionManager.getSessionId();
      binding.active = true;
      const isCurrent = () => binding.active && current === binding;
      // Each envelope is decoded once into a detached copy; malformed ones never reach the service.
      const accept: Parameters<ActivityEvents["on"]>[1] = (data) =>
        safe(() => {
          if (!isCurrent() || !binding.installed) return;
          const envelope = decodeUnknownOrUndefined(ActivityEnvelopeSchema, data);
          if (
            !envelope ||
            envelope.sessionId !== binding.sessionId ||
            envelope.hostToken !== binding.nonce
          )
            return;
          if (envelope.operation === "register" && (!envelope.invoke || !envelope.acknowledge))
            return;
          const { acknowledge } = envelope;
          const event: ActivityEnvelope = acknowledge
            ? {
                ...envelope,
                acknowledge: (available) =>
                  safe(() => {
                    if (isCurrent()) acknowledge(available && binding.installed);
                  }),
              }
            : envelope;
          submit(
            Effect.suspend(() =>
              isCurrent() && binding.installed ? service.receive(event) : Effect.void,
            ),
          );
        });
      safe(() => binding.cleanups.push(pi.events.on(ACTIVITY_EVENT, accept)));
      safe(() =>
        binding.cleanups.push(
          pi.events.on(ACTIVITY_DISCOVER, (data) =>
            safe(() => {
              if (isCurrent() && isDiscovery(data) && data.sessionId === binding.sessionId)
                announce(binding);
            }),
          ),
        ),
      );
      if (run)
        safe(() =>
          binding.cleanups.push(
            installActivityView(pi.events, {
              sessionId: binding.sessionId!,
              hostToken: binding.nonce,
              current: () => isCurrent() && binding.installed,
              open: (section, signal) =>
                run(
                  Effect.suspend(() =>
                    isCurrent() && binding.installed
                      ? host.open(ctx, section)
                      : Effect.fail(new ActivityError({ reason: "stale" })),
                  ),
                  signal,
                ),
            }),
          ),
        );
      let returned = false;
      let mounted = false;
      let disposed = false;
      const acknowledgeInstall = () => {
        if (!returned || !mounted || disposed || !isCurrent()) return;
        binding.installed = true;
        announce(binding);
      };
      try {
        ctx.ui.setWidget(
          "cosmic-activity",
          (tui, theme) => {
            if (!isCurrent() || disposed) return neutral();
            binding.render = () => tui.requestRender();
            mounted = true;
            acknowledgeInstall();
            return {
              render: (width) =>
                isCurrent() && binding.installed
                  ? renderActivityWidget(
                      binding.rows,
                      width,
                      Math.min(
                        inputDockVisible() ? COMPACT_WIDGET_ROWS : Number.POSITIVE_INFINITY,
                        activityWidgetHeight(binding.rows, tui.terminal.rows),
                      ),
                      {
                        starting: binding.starting,
                        theme,
                        now: binding.now,
                        collapsed: binding.presentation.collapsed,
                      },
                    )
                  : [],
              invalidate() {},
              dispose() {
                disposed = true;
                if (isCurrent()) {
                  binding.installed = false;
                  safe(binding.close);
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
    open: (ctx, section) =>
      Effect.gen(function* () {
        const binding = current;
        if (
          !binding?.active ||
          !binding.installed ||
          ctx.mode !== "tui" ||
          ctx.sessionManager.getSessionId() !== binding.sessionId
        )
          return false;
        if (binding.manager) return yield* new ActivityError({ reason: "stale" });
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
            const owned = () =>
              !closing && binding.active && current === binding && binding.manager === owner;
            const component = new ActivityComponent({
              snapshot: () => binding.rows,
              ...(section && { initialSection: section }),
              title: section ? MANAGER_TITLES[section] : "Activity",
              starting: () => binding.starting,
              presentation: binding.presentation,
              theme,
              now: () => binding.now,
              height: getHeight,
              close: finish,
              invoke: (request) => {
                if (owned()) submit(invokeOrWarn(binding.service, request, ctx));
              },
              requestRender: () => tui.requestRender(),
              ...fullScreenKeybindingOptions(keybindings),
              cancelDetail: () => safe(() => detailController?.abort()),
              loadDetail: (request, deliver) => {
                safe(() => detailController?.abort());
                if (closing) return;
                const controller = new AbortController();
                detailController = controller;
                submit(
                  serviceDetail(binding.service, request, (text) => {
                    if (!controller.signal.aborted && owned()) deliver(text);
                  }),
                  controller.signal,
                );
              },
            });
            binding.update = () => {
              if (owned()) component.update();
            };
            return component;
          },
        }).pipe(
          Effect.mapError(() => new ActivityError({ reason: "failed" })),
          Effect.ensuring(
            Effect.sync(() => {
              if (binding.manager !== owner) return;
              binding.manager = undefined;
              binding.close = () => undefined;
              binding.update = () => undefined;
              binding.render = previousRender;
              if (binding.active) safe(binding.render);
            }),
          ),
        );
        // Handoff actions open producer UI, so they run only after the manager has closed.
        if (action && binding.active && current === binding)
          yield* invokeOrWarn(binding.service, action, ctx);
        return true;
      }),
  };
  return host;
}
const invokeOrWarn = (
  service: ActivityServiceContract,
  request: ActivityActionRequest,
  ctx: ExtensionContext,
) =>
  service
    .invoke(request)
    .pipe(
      Effect.tapError(() =>
        Effect.sync(() =>
          notifyAtHostBoundary(ctx, "That action is no longer available", "warning"),
        ),
      ),
    );
const serviceDetail = (
  service: ActivityServiceContract,
  request: Parameters<ActivityServiceContract["detail"]>[0],
  deliver: (text: string) => void,
) =>
  service.detail(request).pipe(
    Effect.orElseSucceed(() => "Details aren't available; the item may have changed"),
    Effect.flatMap((text) => Effect.sync(() => safe(() => deliver(text)))),
  );
