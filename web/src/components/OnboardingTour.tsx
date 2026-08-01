import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TOUR_STEPS, type TourStep } from "../onboarding/steps";
import { markOnboardingDone } from "../onboarding/storage";
import { centerBubble, padRect, placeBubble, type RectLike } from "../onboarding/geometry";
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
  return document.querySelector<HTMLElement>(`[data-tour="${id}"]`);
}

function toRect(el: HTMLElement): RectLike {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
}

async function waitForTarget(id: string, attempts = 20, delayMs = 50): Promise<HTMLElement | null> {
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
  const step = TOUR_STEPS[stepIdx] ?? TOUR_STEPS[0];

  const finish = useCallback((done: boolean) => {
    markOnboardingDone(done ? "finished" : "skipped");
    setStepIdx(0);
    setSpot(null);
    onClose();
  }, [onClose]);

  const prepareStep = useCallback(async (s: TourStep) => {
    ensureSidebarOpen();
    const prep = s.prepare ?? "none";
    if (prep === "settings-models") {
      onNavigate({ type: "settings", section: "models" });
    } else if (prep === "rooms-panel") {
      // Land on home if no room; rooms panel is always available via rail domain.
      if (roomIds.length > 0) onNavigate({ type: "room", id: roomIds[0] });
      else onNavigate(null);
    } else if (prep === "first-room") {
      if (roomIds.length > 0) onNavigate({ type: "room", id: roomIds[0] });
      else onNavigate(null);
    }
    // Let React paint the destination view before measuring.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, [ensureSidebarOpen, onNavigate, roomIds]);

  const layoutStep = useCallback(async (s: TourStep) => {
    await prepareStep(s);

    if (s.center || !s.target) {
      setSpot(null);
      const bw = s.wide ? 380 : 320;
      const bh = bubbleRef.current?.offsetHeight || 220;
      setBubblePos(centerBubble(bw, bh, window.innerWidth, window.innerHeight));
      return;
    }

    const el = await waitForTarget(s.target);
    if (!el) {
      // Target missing (e.g. no room → no composer): fall back to centered card with same copy.
      setSpot(null);
      const bw = s.wide ? 380 : 320;
      const bh = bubbleRef.current?.offsetHeight || 220;
      setBubblePos(centerBubble(bw, bh, window.innerWidth, window.innerHeight));
      return;
    }

    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = toRect(el);
    const padded = padRect(rect, 6);
    setSpot(padded);

    // Measure bubble after content paint
    await new Promise((r) => requestAnimationFrame(r));
    const bw = bubbleRef.current?.offsetWidth || (s.wide ? 380 : 320);
    const bh = bubbleRef.current?.offsetHeight || 220;
    setBubblePos(
      placeBubble(rect, s.place ?? "right", bw, bh, window.innerWidth, window.innerHeight),
    );
  }, [prepareStep]);

  useEffect(() => {
    if (!open) return;
    setStepIdx(0);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    void layoutStep(step);
  }, [open, stepIdx, step, layoutStep]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    const onResize = () => { void layoutStep(step); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, finish, layoutStep, step]);

  if (!open) return null;

  const isLast = stepIdx >= TOUR_STEPS.length - 1;
  const bw = step.wide ? 380 : 320;

  return (
    <div className="contents" data-onboarding-tour="active" aria-modal="true" role="dialog" aria-label="Product tour">
      {/* Full dim when no spotlight target */}
      {!spot && (
        <div
          className="fixed inset-0 z-[55]"
          style={{ background: "rgba(15,18,25,0.55)" }}
          onClick={() => finish(false)}
        />
      )}

      {/* Spotlight cutout via huge box-shadow */}
      {spot && (
        <div
          className="fixed z-[60] pointer-events-none rounded-xl transition-all duration-200"
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
        className="fixed z-[70] bg-surface-1 border border-line rounded-xl p-4 transition-all duration-200"
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
