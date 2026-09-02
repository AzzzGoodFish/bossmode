/**
 * copyText — clipboard write that works on plain-http LAN origins too.
 * `navigator.clipboard` exists only in secure contexts (localhost / https);
 * on http://192.168.x.x it is undefined and an optional-chained call silently
 * no-ops (fish 2026-09-02: "消息拷贝功能无效"). Fall back to the legacy
 * selection+execCommand path, and report success honestly so callers never
 * flash a false "Copied".
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied / focus loss — try the legacy path before failing
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
