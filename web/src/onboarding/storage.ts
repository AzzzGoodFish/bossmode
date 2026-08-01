/** Onboarding tour persistence — one-shot first launch, Help can replay. */

export const ONBOARDING_DONE_KEY = "onboarding.v1.done";

export type OnboardingDoneState = "finished" | "skipped";

export function getOnboardingDone(): OnboardingDoneState | null {
  try {
    const v = localStorage.getItem(ONBOARDING_DONE_KEY);
    if (v === "finished" || v === "skipped") return v;
    return null;
  } catch {
    return null;
  }
}

export function isOnboardingDone(): boolean {
  return getOnboardingDone() !== null;
}

export function markOnboardingDone(state: OnboardingDoneState): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, state);
  } catch {
    /* private mode / quota */
  }
}

export function clearOnboardingDone(): void {
  try {
    localStorage.removeItem(ONBOARDING_DONE_KEY);
  } catch {
    /* ignore */
  }
}
