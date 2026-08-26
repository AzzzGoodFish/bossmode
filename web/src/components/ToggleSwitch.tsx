/** Shared toggle switch (fish 2026-08-26: the member-settings local copy
 * dropped the thumb's `left-0.5` base, so the ON dot drifted ~8px past the
 * track's right edge — the absolutely positioned span's static position came
 * from the button's inline context, not from x=0. Second occurrence of this
 * bug class, so the component now exists exactly once.
 *
 * Geometry: 36×20 track, 16px thumb, 2px inset both sides — ON translates
 * 16px (2+16+16 = 34 → 2px right inset). Verify dots with bboxes if the
 * numbers ever change. */
export function ToggleSwitch({ on, onToggle, label, disabled }: {
  on: boolean;
  onToggle: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onToggle(!on)}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${on ? "bg-accent" : "bg-line-strong"}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}
