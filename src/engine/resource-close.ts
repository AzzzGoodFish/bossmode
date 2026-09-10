/** A timeout is an explicit cleanup failure, never confirmation of resource release. */
export async function awaitResourceClose(closed: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} closure was not confirmed within 10 seconds`)), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
