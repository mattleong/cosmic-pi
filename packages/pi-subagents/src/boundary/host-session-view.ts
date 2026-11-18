import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  KeybindingsManager,
  Theme,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, getKeybindings, type TUI, type Terminal } from "@earendil-works/pi-tui";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Fn from "effect/Function";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import { lookupToolRenderers } from "pi-code-previews";
import { findOrUndefined } from "pi-cosmic-core/array";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { hasCustomSurface, openOwnedSurface } from "pi-cosmic-ui/boundary/host-surface";
import { userFailureText, type SubagentError } from "../run/errors.ts";
import { isActiveRunState, type SubagentProjection, type SubagentRunView } from "../run/model.ts";
import { SubagentService } from "../run/service.ts";
import type { SubagentTranscriptEvent } from "../run/transcript.ts";
import { SessionTranscript } from "../ui/session-transcript.ts";
import { sessionSubmitKind, SubagentSessionView } from "../ui/session-view.ts";

const SPINNER_REFRESH = "160 millis";
const WATCH_RETRY = { schedule: Schedule.spaced("2 seconds"), times: 5 } as const;

type ViewAction =
  | { readonly type: "watch" }
  | { readonly type: "projection" }
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "interrupt" };

export interface SubagentSessionViewOptions {
  readonly ctx: ExtensionContext;
  readonly events: ExtensionAPI["events"];
  readonly runId: string;
  /** When present the view owns a second display, not a surface in the parent Pi. */
  readonly terminal?: Terminal | undefined;
  readonly projection: () => SubagentProjection;
  readonly subscribeProjection: (listener: () => void) => () => void;
  readonly isCurrent: () => boolean;
  readonly messageRenderer: (customType: string) => MessageRenderer | undefined;
  /** Renderers for the tools only a child registers, which no session owner can be asked for. */
  readonly childToolRenderers: (name: string) => ToolRenderers | undefined;
}

/**
 * Opens a run's session as a screen in the root's own Pi and resolves when the user leaves it.
 * The root stays the run's only owner: the screen watches the conversation the service shows it,
 * and what the user types goes through the same send, resume, and interrupt the Activity actions
 * use. Nothing here survives the screen: closing it ends the watch.
 */
export const openSubagentSessionView = Effect.fn("SubagentSessionView.open")(function* (
  options: SubagentSessionViewOptions,
) {
  const { ctx, runId } = options;
  if (!options.terminal && !hasCustomSurface(ctx)) return;
  const service = yield* SubagentService;
  const currentRun = () => findOrUndefined(options.projection().runs, (run) => run.id === runId);
  const rendererCache = new Map<string, ToolRenderers>();
  const toolRenderers = (name: string): ToolRenderers | undefined => {
    const cached =
      rendererCache.get(name) ??
      options.childToolRenderers(name) ??
      lookupToolRenderers(options.events, name);
    if (cached) rendererCache.set(name, cached);
    return cached;
  };

  yield* Effect.scoped(
    Effect.gen(function* () {
      const actions = yield* Queue.unbounded<ViewAction>();
      const offer = (action: ViewAction): void => {
        Queue.offerUnsafe(actions, action);
      };
      const watching = yield* FiberHandle.make<void, never>();
      let view: SubagentSessionView | undefined;
      let transcript: SessionTranscript | undefined;
      let render: (() => void) | undefined;
      const requestRender = () => render?.();
      // Each watch has a generation, so an event of a replaced watch can't draw over its successor.
      let watchGeneration = 0;
      let watchedPid: number | undefined;
      let now = yield* Clock.currentTimeMillis;

      const onTranscript = (generation: number) => (event: SubagentTranscriptEvent) => {
        if (generation !== watchGeneration || !transcript || !view) return;
        if (event.type === "snapshot") {
          transcript.reset(event.messages, event.live);
          view.markLoaded();
        } else if (event.type === "gap" || transcript.apply(event.value) === "stale")
          offer({ type: "watch" });
        requestRender();
      };
      const watch = Effect.suspend(() => {
        const generation = ++watchGeneration;
        watchedPid = currentRun()?.pid;
        return FiberHandle.run(
          watching,
          Effect.scoped(
            service
              .watchTranscript(runId, onTranscript(generation))
              .pipe(Effect.andThen(Effect.never)),
          ).pipe(
            Effect.retry(WATCH_RETRY),
            Effect.catch(() =>
              Effect.sync(() => {
                if (generation === watchGeneration)
                  view?.setNotice("Couldn't load this conversation");
              }),
            ),
          ),
        );
      });

      const report = (text: string) => (error: SubagentError) =>
        Effect.sync(() => {
          view?.setNotice(userFailureText(error));
          if (text) view?.restoreDraft(text);
        });
      const deliver = (run: SubagentRunView, text: string) =>
        sessionSubmitKind(run) === "resume"
          ? Effect.asVoid(service.resume(runId, text))
          : Effect.asVoid(service.send(runId, text));
      const submit = (text: string) =>
        Effect.suspend(() => {
          const run = currentRun();
          if (!run) return Effect.void;
          return deliver(run, text).pipe(
            // A run that finished as the message left takes it as its next assignment instead.
            Effect.catch((error) => {
              const latest = currentRun();
              // Only a definite refusal before delivery can become a new assignment.
              return "code" in error &&
                error.code === "agent_unavailable" &&
                latest &&
                sessionSubmitKind(run) !== "resume" &&
                sessionSubmitKind(latest) === "resume"
                ? deliver(latest, text)
                : Effect.fail(error);
            }),
            Effect.catch(report(text)),
          );
        });
      const handle = (action: ViewAction): Effect.Effect<void> => {
        switch (action.type) {
          case "watch":
            return Effect.asVoid(watch);
          case "projection": {
            const pid = currentRun()?.pid;
            // A resume gives the run a new process, whose conversation needs a new watch.
            if (pid !== undefined && pid !== watchedPid) return Effect.asVoid(watch);
            return Effect.sync(requestRender);
          }
          case "submit":
            return submit(action.text);
          case "interrupt":
            return service.interrupt(runId).pipe(Effect.asVoid, Effect.catch(report("")));
        }
        return Fn.absurd(action);
      };

      const unsubscribe = options.subscribeProjection(() => offer({ type: "projection" }));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => invokeHostCallback(unsubscribe, undefined)),
      );
      yield* Effect.forkScoped(Effect.forever(Queue.take(actions).pipe(Effect.flatMap(handle))));
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(SPINNER_REFRESH).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.map((time) => {
              now = time;
              const run = currentRun();
              if (run && isActiveRunState(run.state)) requestRender();
            }),
          ),
        ),
      );

      const mount = ({
        tui,
        theme,
        keybindings,
        getHeight,
        finish,
      }: {
        readonly tui: TUI;
        readonly theme: Theme;
        readonly keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
        readonly getHeight: () => number;
        readonly finish: (value: undefined) => void;
      }) => {
        render = () => invokeHostCallback(() => tui.requestRender(), undefined);
        transcript = new SessionTranscript({
          tui,
          cwd: currentRun()?.cwd ?? ctx.cwd,
          toolRenderers,
          messageRenderer: options.messageRenderer,
        });
        view = new SubagentSessionView({
          tui,
          theme,
          keybindings,
          getHeight,
          getNow: () => now,
          transcript,
          getRun: currentRun,
          onSubmit: (text) => offer({ type: "submit", text }),
          onInterrupt: () => offer({ type: "interrupt" }),
          onLeave: () => finish(undefined),
        });
        offer({ type: "watch" });
        return view;
      };
      const terminal = options.terminal;
      if (!terminal) {
        yield* openOwnedSurface<undefined>(ctx, {
          placement: "screen",
          closedValue: undefined,
          isCurrent: options.isCurrent,
          create: mount,
        }).pipe(Effect.ignore);
        return;
      }
      // Both screens use the same editor, transcript and service. The pane owns only this
      // TUI and its scoped watch; closing it must never interrupt the writer.
      const left = yield* Deferred.make<void>();
      const tui = new TuiMainScreen(terminal);
      const screen = mount({
        tui,
        theme: ctx.ui.theme,
        keybindings: getKeybindings(),
        getHeight: () => terminal.rows,
        finish: () => {
          Deferred.doneUnsafe(left, Effect.void);
        },
      });
      tui.addChild(screen);
      tui.setFocus(screen);
      yield* Effect.addFinalizer(() => Effect.sync(() => tui.stop()));
      tui.start();
      yield* Deferred.await(left);
    }),
  );
});
