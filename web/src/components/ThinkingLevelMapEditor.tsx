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
 *
 * Modes/customs live in local state so "Custom value…" with an empty input stays
 * selected (intermediate UI state). Empty custom still omits the map entry.
 */
import { useEffect, useRef, useState } from "react";
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

function modesFromMap(map: LevelMap | undefined): Record<ThinkingLevelKey, LevelMode> {
  const m = {} as Record<ThinkingLevelKey, LevelMode>;
  for (const level of THINKING_LEVEL_KEYS) m[level] = levelModeFromMap(map, level);
  return m;
}

function customsFromMap(map: LevelMap | undefined): Record<ThinkingLevelKey, string> {
  const m = {} as Record<ThinkingLevelKey, string>;
  for (const level of THINKING_LEVEL_KEYS) m[level] = customValueFromMap(map, level);
  return m;
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
        if (!raw) continue; // empty custom: keep UI mode, omit entry
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
        if (!raw) continue; // empty custom: keep UI mode, omit entry
        out[level] = raw;
        touched = true;
      }
    }
  }
  return touched ? out : undefined;
}

/** Summary from local modes — empty Custom still counts as available (unlock intent) but not remapped until filled. */
export function summarizeThinkingModes(
  modes: Record<ThinkingLevelKey, LevelMode>,
  customs: Record<ThinkingLevelKey, string>,
): string {
  let available = 0;
  let remapped = 0;
  let disabled = 0;
  let allDefault = true;
  for (const level of THINKING_LEVEL_KEYS) {
    const mode = modes[level] ?? (MID_LEVELS.has(level) ? "as-is" : "off");
    const defaultMode: LevelMode = MID_LEVELS.has(level) ? "as-is" : "off";
    if (mode !== defaultMode) allDefault = false;
    if (mode === "off") {
      disabled += 1;
      continue;
    }
    available += 1;
    if (mode === "custom" && (customs[level] || "").trim()) remapped += 1;
  }
  if (allDefault) {
    return `${available} available · off–high as-is`;
  }
  const parts = [`${available} available`];
  if (remapped) parts.push(`${remapped} remapped`);
  if (disabled) parts.push(`${disabled} off`);
  return parts.join(" · ");
}

export function summarizeThinkingMap(map: LevelMap | undefined): string {
  return summarizeThinkingModes(modesFromMap(map), customsFromMap(map));
}

function serializeMap(map: LevelMap | undefined): string {
  return JSON.stringify(map ?? null);
}

const selectCls =
  "bg-inset border border-line-soft rounded-md px-1.5 py-1 text-[11px] text-ink-2 focus:outline-none focus:border-line-strong cursor-pointer w-full";
const inputCls =
  "w-full bg-inset border border-[rgba(47,184,170,0.4)] rounded-md px-2 py-1 text-[11px] text-ink-1 font-mono focus:outline-none focus:border-accent placeholder:text-ink-4";

export function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: LevelMap | undefined;
  onChange: (next: LevelMap | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [modes, setModes] = useState<Record<ThinkingLevelKey, LevelMode>>(() => modesFromMap(value));
  const [customs, setCustoms] = useState<Record<ThinkingLevelKey, string>>(() => customsFromMap(value));
  // Track last map we pushed so external value reloads re-seed local state without
  // wiping the empty-custom intermediate state after our own onChange.
  const emittedRef = useRef(serializeMap(value));

  useEffect(() => {
    const incoming = serializeMap(value);
    if (incoming === emittedRef.current) return;
    emittedRef.current = incoming;
    setModes(modesFromMap(value));
    setCustoms(customsFromMap(value));
  }, [value]);

  const push = (nextModes: Record<ThinkingLevelKey, LevelMode>, nextCustoms: Record<ThinkingLevelKey, string>) => {
    const next = buildThinkingLevelMap(nextModes, nextCustoms);
    emittedRef.current = serializeMap(next);
    onChange(next);
  };

  const setMode = (level: ThinkingLevelKey, mode: LevelMode) => {
    const nextModes = { ...modes, [level]: mode };
    const nextCustoms = { ...customs };
    if (mode !== "custom") nextCustoms[level] = "";
    setModes(nextModes);
    setCustoms(nextCustoms);
    push(nextModes, nextCustoms);
  };

  const setCustom = (level: ThinkingLevelKey, raw: string) => {
    const nextCustoms = { ...customs, [level]: raw };
    const nextModes = { ...modes, [level]: "custom" as LevelMode };
    setModes(nextModes);
    setCustoms(nextCustoms);
    push(nextModes, nextCustoms);
  };

  const summary = summarizeThinkingModes(modes, customs);

  return (
    <div className="border-t border-line-soft pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 py-0.5 text-left bg-transparent border-0 cursor-pointer"
      >
        <span
          className={`text-ink-4 text-[10px] shrink-0 transition-transform duration-100 ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ▶
        </span>
        <span className="text-xs font-semibold text-ink-2 shrink-0">Thinking levels</span>
        <span className="text-[11px] text-ink-4 font-mono truncate min-w-0">{summary}</span>
      </button>
      {open && (
        <div className="pt-1">
          <p className="text-[11px] text-ink-4 leading-relaxed my-1 mb-2">
            What this model offers, and the exact value sent to your provider. Defaults match pi&apos;s built-in behavior — most endpoints need no changes.
          </p>
          <div className="flex flex-col gap-1">
            {THINKING_LEVEL_KEYS.map((level) => {
              const mode = modes[level];
              const dim = mode === "off";
              return (
                <div
                  key={level}
                  className="grid items-center gap-2 py-0.5"
                  style={{ gridTemplateColumns: "74px 148px 1fr" }}
                >
                  <code className={`text-[11.5px] font-mono ${dim ? "text-ink-4" : "text-ink-2"}`}>{level}</code>
                  <select
                    className={selectCls}
                    value={mode}
                    onChange={(e) => setMode(level, e.target.value as LevelMode)}
                  >
                    <option value="as-is">As-is</option>
                    <option value="custom">Custom value…</option>
                    <option value="off">Not available</option>
                  </select>
                  {mode === "custom" ? (
                    <input
                      className={inputCls}
                      value={customs[level]}
                      onChange={(e) => setCustom(level, e.target.value)}
                      placeholder={`e.g. ${level === "xhigh" ? "max" : level}`}
                      spellCheck={false}
                    />
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[10.5px] text-ink-4 mt-2 leading-relaxed">
            xhigh / max stay hidden from the level picker until you map or enable them here. Setting a level to{" "}
            <b className="font-semibold">Not available</b> hides it.
          </p>
        </div>
      )}
    </div>
  );
}
