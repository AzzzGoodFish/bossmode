/** Keep the same root WebSocket contract in a packaged UI and Vite development. */
export function createWebSocketUrl(
  pageUrl: string,
  token: string,
  port?: string,
): string {
  const url = new URL(pageUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (port) url.port = port;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("token", token);
  return url.toString();
}
export function webSocketUrl(token: string): string {
  return createWebSocketUrl(
    `${window.location.protocol}//${window.location.host}/`,
    token,
    import.meta.env.DEV ? import.meta.env.VITE_BOSSMODE_WS_PORT : undefined,
  );
}
