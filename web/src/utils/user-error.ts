export function userActionError(action: string, next = "Try again."): string {
  return `Couldn’t ${action}. ${next}`;
}
