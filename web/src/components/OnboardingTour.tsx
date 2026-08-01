import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TOUR_STEPS, type TourStep } from "../onboarding/steps";
import { markOnboardingDone } from "../onboarding/storage";
import {
  centerBubble,
  padRect,
  placeBubble,
  rectsEqual,
  waitForStableRect,
  type RectLike,
} from "../onboarding/geometry";
import type { ActivePage } from "./Sidebar";

export interface OnboardingTourProps {
  open: boolean;
  /** Room ids currently known — used to open first room for the composer step. */
  roomIds: string[];
  onNavigate: (page: ActivePage) => void;
  /** Expand the desktop sidebar panel so rail/panel anchors are visible. */
  ensureSidebarOpen: () => void;
  onClose: () => void;
}

function queryTourTarget(id: string): HTMLElement | null {
  // Prefer the first *visible* match (Connect Provider appears in toolbar + empty state).
  const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`);
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return nodes[0] ?? null;
}

function toRect(el: HTMLElement): RectLike {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
}

async function waitForTarget(id: string, attempts = 30, delayMs = 50): Promise<HTMLElement | null> {
  for (let i = 0; i < attempts; i++) {
    const el = queryTourTarget(id);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return queryTourTarget(id);
}

export function OnboardingTour({ open, roomIds, onNavigate, ensureSidebarOpen, onClose }: OnboardingTourProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [spot, setSpot] = useState<RectLike | null>(null);
  const [bubblePos, setBubblePos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const bubbleRef = useRef<HTMLDivElement>(null);
  const targetElRef = useRef<HTMLElement | null>(null);
  const stepRef = useRef<TourStep>(TOUR_STEPS[0]);
  const spotRef = useRef<RectLike | null>(null);
  const genRef = useRef(0); // invalidate in-flight layout when step changes
  const step = TOUR_STEPS[stepIdx] ?? TOUR_STEPS[0];
  stepRef.current = step;

  const finish = useCallback((done: boolean) => {
    markOnboardingDone(done ? "finished" : "skipped");
    setStepIdx(0);
    setSpot(null);
    spotRef.current = null;
    targetElRef.current = null;
    onClose();
  }, [onClose]);

  const applyTargetRect = useCallback((rect: RectLike | null, s: TourStep) => {
    if (!rect) {
      setSpot(null);
      spotRef.current = null;
      const bw = s.wide ? 380 : 320;
      const bh = bubbleRef.current?.offsetHeight || 220;
      setBubblePos(centerBubble(bw, bh, window.innerWidth, window.innerHeight));
      return;
    }
    const padded = padRect(rect, 6);
    if (!rectsEqual(spotRef.current, padded)) {
      spotRef.current = padded;
      setSpot(padded);
    }
    const bw = bubbleRef.current?.offsetWidth || (s.wide ? 380 : 320);
    const bh = bubbleRef.current?.offsetHeight || 220;
    setBubblePos(
      placeBubble(rect, s.place ?? "right", bw, bh, window.innerWidth, window.innerHeight),
    );
  }, []);

  /** Remeasure current target without re-navigating (sticky follow). */
  const remeasureTarget = useCallback(() => {
    const s = stepRef.current;
    if (s.center || !s.target) return;
    const el = targetElRef.current && document.contains(targetElRef.current)
      ? targetElRef.current
      : (s.target ? queryTourTarget(s.target) : null);
    if (!el) return;
    targetElRef.current = el;
    applyTargetRect(toRect(el), s);
  }, [applyTargetRect]);

  const prepareStep = useCallback(async (s: TourStep) => {
    ensureSidebarOpen();
    const prep = s.prepare ?? "none";
    if (prep === "settings-models") {
      onNavigate({ type: "settings", section: "models" });
    } else if (prep === "rooms-panel") {
      if (roomIds.length > 0) onNavigate({ type: "room", id: roomIds[0] });
      else onNavigate(null);
    } else if (prep === "first-room") {
      if (roomIds.length > 0) onNavigate({ type: "room", id: roomIds[0] });
      else onNavigate(null);
    }
    // Let React paint the destination view before measuring.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, [ensureSidebarOpen, onNavigate, roomIds]);

  const layoutStep = useCallback(async (s: TourStep, gen: number) => {
    await prepareStep(s);
    if (gen !== genRef.current) return;

    if (s.center || !s.target) {
      targetElRef.current = null;
      applyTargetRect(null, s);
      return;
    }

    const el = await waitForTarget(s.target);
    if (gen !== genRef.current) return;
    if (!el) {
      targetElRef.current = null;
      applyTargetRect(null, s);
      return;
    }

    targetElRef.current = el;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });

    // Wait until layout stops moving (async Models cards reflow after navigate).
    const stable = await waitForStableRect(
      () => {
        const cur = targetElRef.current && document.contains(targetElRef.current)
          ? targetElRef.current
          : queryTourTarget(s.target!);
        if (!cur) return null;
        targetElRef.current = cur;
        return toRect(cur);
      },
      { stableFrames: 2, maxWaitMs: 900, intervalMs: 32 },
    );
    if (gen !== genRef.current) return;
    applyTargetRect(stable, s);

    // Late async content (profile cards) may land after the stable window — one more pass.
    window.setTimeout(() => {
      if (gen !== genRef.current) return;
      remeasureTarget();
    }, 350);
  }, [prepareStep, applyTargetRect, remeasureTarget]);

  useEffect(() => {
    if (!open) return;
    setStepIdx(0);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const gen = ++genRef.current;
    void layoutStep(step, gen);
    return () => { genRef.current += 1; }; // invalidate in-flight on step change
  }, [open, stepIdx, step, layoutStep]);

  // Sticky follow: keep spotlight glued while Models cards / resize / scroll reflow the page.
  useEffect(() => {
    if (!open) return;
    const s = step;
    if (s.center || !s.target) return;

    const onScrollOrResize = () => remeasureTarget();
    window.addEventListener("resize", onScrollOrResize);
    // capture phase catches scroll in any nested container (Settings main pane)
    document.addEventListener("scroll", onScrollOrResize, true);

    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => remeasureTarget())
      : null;
    const mo = typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => remeasureTarget())
      : null;

    const attach = () => {
      const el = targetElRef.current ?? queryTourTarget(s.target!);
      if (!el) return;
      targetElRef.current = el;
      ro?.observe(el);
      // Watch body for late-inserted profile cards that shove the button down.
      mo?.observe(document.body, { childList: true, subtree: true, attributes: true });
    };
    attach();

    // Re-attach periodically lightly in case target node is replaced by React
    const tick = window.setInterval(() => {
      const el = queryTourTarget(s.target!);
      if (el && el !== targetElRef.current) {
        ro?.disconnect();
        targetElRef.current = el;
        ro?.observe(el);
        remeasureTarget();
      }
    }, 400);

    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      document.removeEventListener("scroll", onScrollOrResize, true);
      ro?.disconnect();
      mo?.disconnect();
      window.clearInterval(tick);
    };
  }, [open, stepIdx, step, remeasureTarget]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, finish]);

  if (!open) return null;

  const isLast = stepIdx >= TOUR_STEPS.length - 1;
  const bw = step.wide ? 380 : 320;

  return (
    <div className="contents" data-onboarding-tour="active" aria-modal="true" role="dialog" aria-label="Product tour">
      {/* Full dim when no spotlight target — no click-to-skip (avoid accidental dismiss). */}
      {!spot && (
        <div
          className="fixed inset-0 z-[55]"
          style={{ background: "rgba(15,18,25,0.55)" }}
          aria-hidden
        />
      )}

      {/* Spotlight cutout via huge box-shadow */}
      {spot && (
        <div
          className="fixed z-[60] pointer-events-none rounded-xl transition-[left,top,width,height] duration-150"
          style={{
            left: spot.left,
            top: spot.top,
            width: spot.width,
            height: spot.height,
            boxShadow: "0 0 0 9999px rgba(15,18,25,0.55)",
            outline: "2px solid var(--accent)",
            outlineOffset: 2,
          }}
          aria-hidden
        />
      )}

      {/* Bubble */}
      <div
        ref={bubbleRef}
        className="fixed z-[70] bg-surface-1 border border-line rounded-xl p-4 transition-[left,top] duration-150"
        style={{
          left: bubblePos.left,
          top: bubblePos.top,
          width: bw,
          boxShadow: "var(--shadow-pop, 0 12px 40px rgba(16,24,40,0.22))",
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === stepIdx ? "w-4 bg-accent" : "w-1.5 bg-surface-3"
                }`}
              />
            ))}
          </div>
          <span className="text-[10.5px] text-ink-4">
            {stepIdx + 1} / {TOUR_STEPS.length}
          </span>
        </div>

        <div className="text-[14px] font-bold text-ink-1 mb-1.5">{step.title}</div>

        <div className="space-y-2 text-[12.5px] leading-relaxed text-ink-2">
          {step.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {step.blocks?.map((b) => (
            <div key={b.heading} className="mt-1">
              <div className="font-semibold text-ink-1 mb-0.5">{b.heading}</div>
              <ol className={b.heading === "How" ? "list-decimal pl-4 space-y-0.5" : "list-none space-y-1"}>
                {b.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between mt-3.5">
          <button
            type="button"
            onClick={() => finish(false)}
            className="text-[12px] text-ink-4 hover:text-ink-1 underline underline-offset-2 cursor-pointer bg-transparent border-0"
          >
            Skip tour
          </button>
          <div className="flex gap-2">
            {stepIdx > 0 && (
              <button
                type="button"
                onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
                className="px-3 py-1.5 text-[12px] font-semibold rounded-lg border border-line text-ink-2 hover:bg-surface-2 cursor-pointer"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (isLast) finish(true);
                else setStepIdx((i) => i + 1);
              }}
              className="px-3 py-1.5 text-[12px] font-semibold rounded-lg bg-accent text-accent-contrast hover:opacity-90 cursor-pointer border-0"
            >
              {step.primary}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
