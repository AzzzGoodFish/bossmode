/**
 * Thinking levels editor for custom provider model cards.
 * Per designer prototype thinking-level-map-v1 (fish 2026-08-09).
 *
 * Three states per level:
 *   As-is          — omit key (mid) or write level name (xhigh/max unlock passthrough)
 *   Custom value…  — write user string
 *   Not available  — write null (mid) or omit (xhigh/max)
 *
 * Full defaults (off–high as-is, xhigh/max unavailable) → undefined map (field omitted).
 */
import { useMemo, useState } from "react";
import type { ModelDefinitionConfig } from "../api/client";

export type ThinkingLevelKey = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type LevelMode = "as-is" | "custom" | "off";

export const THINKING_LEVEL_KEYS: ThinkingLevelKey[] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

const MID_LEVELS = new Set<ThinkingLevelKey>(["off", "minimal", "low", "medium", "high"]);

type LevelMap = NonNullable<ModelDefinitionConfig["thinkingLevelMap"]>;

export function levelModeFromMap(map: LevelMap | undefined, level: ThinkingLevelKey): LevelMode {
  if (!map || !(level in map)) {
    return MID_LEVELS.has(level) ? "as-is" : "off";
  }
  const v = map[level];
  if (v === null) return "off";
  if (v === level) return "as-is";
  return "custom";
}

export function customValueFromMap(map: LevelMap | undefined, level: ThinkingLevelKey): string {
  const v = map?.[level];
  return typeof v === "string" && v !== level ? v : "";
}

/** Convert UI state → map. Returns undefined when fully default (omit field). */
export function buildThinkingLevelMap(
  modes: Record<ThinkingLevelKey, LevelMode>,
  customs: Record<ThinkingLevelKey, string>,
): LevelMap | undefined {
  const out: LevelMap = {};
  let touched = false;
  for (const level of THINKING_LEVEL_KEYS) {
    const mode = modes[level] ?? (MID_LEVELS.has(level) ? "as-is" : "off");
    if (MID_LEVELS.has(level)) {
      if (mode === "as-is") continue; // default — omit
      if (mode === "off") {
        out[level] = null;
        touched = true;
      } else {
        const raw = (customs[level] || "").trim();
        if (!raw) continue; // empty custom falls back to as-is
        out[level] = raw;
        touched = true;
      }
    } else {
      // xhigh / max — default is off (omit)
      if (mode === "off") continue;
      if (mode === "as-is") {
        out[level] = level; // unlock passthrough
        touched = true;
      } else {
        const raw = (customs[level] || "").trim();
        if (!raw) continue;
        out[level] = raw;
        touched = true;
      }
    }
  }
  return touched ? out : undefined;
}

export function summarizeThinkingMap(map: LevelMap | undefined): string {
  let available = 0;
  let remapped = 0;
  let disabled = 0;
  for (const level of THINKING_LEVEL_KEYS) {
    const mode = levelModeFromMap(map, level);
    if (mode === "off") disabled += 1;
    else {
      available += 1;
      if (mode === "custom") remapped += 1;
    }
  }
  if (!map || Object.keys(map).length === 0) {
    return `${available} available · off–high as-is`;
  }
  const parts = [`${available} available`];
  if (remapped) parts.push(`${remapped} remapped`);
  if (disabled) parts.push(`${disabled} off`);
  return parts.join(" · ");
}

const selectCls =
  "bg-inset border border-line rounded px-2 py-1.5 text-xs text-ink-1 focus:outline-none focus:border-line-strong cursor-pointer";
const inputCls =
  "w-full bg-inset border border-line rounded px-2 py-1.5 text-xs text-ink-1 font-mono focus:outline-none focus:border-line-strong";

export function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: LevelMap | undefined;
  onChange: (next: LevelMap | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const modes = useMemo(() => {
    const m = {} as Record<ThinkingLevelKey, LevelMode>;
    for (const level of THINKING_LEVEL_KEYS) m[level] = levelModeFromMap(value, level);
    return m;
  }, [value]);
  const customs = useMemo(() => {
    const m = {} as Record<ThinkingLevelKey, string>;
    for (const level of THINKING_LEVEL_KEYS) m[level] = customValueFromMap(value, level);
    return m;
  }, [value]);

  const setMode = (level: ThinkingLevelKey, mode: LevelMode) => {
    const nextModes = { ...modes, [level]: mode };
    const nextCustoms = { ...customs };
    if (mode !== "custom") nextCustoms[level] = "";
    onChange(buildThinkingLevelMap(nextModes, nextCustoms));
  };

  const setCustom = (level: ThinkingLevelKey, raw: string) => {
    const nextCustoms = { ...customs, [level]: raw };
    const nextModes = { ...modes, [level]: "custom" as LevelMode };
    onChange(buildThinkingLevelMap(nextModes, nextCustoms));
  };

  const summary = summarizeThinkingMap(value);

  return (
    <div className="border border-line-soft rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2/60 cursor-pointer"
      >
        <div className="min-w-0">
          <div className="text-xs font-semibold text-ink-1">Thinking levels</div>
          <div className="text-[11px] text-ink-3 truncate mt-0.5">{summary}</div>
        </div>
        <span className="text-ink-4 text-[11px] shrink-0">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-line-soft px-3 py-2 space-y-2 bg-inset/40">
          <p className="text-[11px] text-ink-3 leading-relaxed">
            Control which thinking levels appear for this model and what value is sent to the provider.
            Leave mid-levels as-is unless your endpoint uses different names. xhigh/max stay off until you enable them.
          </p>
          {THINKING_LEVEL_KEYS.map((level) => {
            const mode = modes[level];
            return (
              <div key={level} className="flex flex-wrap items-center gap-2">
                <code className="text-[11px] font-mono text-ink-2 w-16 shrink-0">{level}</code>
                <select
                  className={selectCls}
                  value={mode}
                  onChange={(e) => setMode(level, e.target.value as LevelMode)}
                >
                  <option value="as-is">As-is</option>
                  <option value="custom">Custom value…</option>
                  <option value="off">Not available</option>
                </select>
                {mode === "custom" && (
                  <input
                    className={`${inputCls} flex-1 min-w-[8rem]`}
                    value={customs[level]}
                    onChange={(e) => setCustom(level, e.target.value)}
                    placeholder={`e.g. ${level === "xhigh" ? "max" : level}`}
                    spellCheck={false}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
