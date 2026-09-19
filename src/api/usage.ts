import { getPlatformUsageReport, getRoomUsageReport, type UsageReportQuery } from "../app/usage-actions.js";
import { addRoute, requestUrl, sendJson } from "./http.js";

function date(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function query(request: Parameters<typeof requestUrl>[0]): UsageReportQuery {
  const params = requestUrl(request).searchParams;
  return {
    from: date(params.get("from")),
    to: date(params.get("to")),
    member: params.get("member") || undefined,
    agent: params.get("agent") || undefined,
    model: params.get("model") || undefined,
  };
}

addRoute("GET", "/api/rooms/:id/usage", async (request, response, params) => {
  const report = getRoomUsageReport(params.id, query(request));
  if (!report) return sendJson(response, 404, { error: "room not found" });
  sendJson(response, 200, report);
});

addRoute("GET", "/api/usage", async (request, response) => {
  sendJson(response, 200, getPlatformUsageReport(query(request)));
});
