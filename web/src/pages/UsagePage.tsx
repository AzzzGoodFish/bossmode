// Usage — token consumption by identity, room and time (v3 minimal).
//
// Rendered inside Settings → Usage, full-width. One unified filter bar
// (Room · Agent · Days) is the single source of truth; the donut and table
// rows also drill as shortcuts and sync back to the filter state.
//
// Breakdown dimension is unambiguous:
//   room selected            → By member
//   agent selected, no room  → By room
//   neither                  → By agent
//
// No by-model view (historical attribution reverted; model still stamped on new
// data for a future revisit). The trend is colored by agent. Spend is a table
// column + the filter readout, not a separate view.
import { useEffect, useMemo, useState } from "react";
import {
  getPlatformUsage,
  getRoomUsage,
  type UsageResponse,
  type UsageSeriesPoint,
} from "../api/client";

type RangeDays = 7 | 14 | 30;

// Agent identity → chart color (theme-aware product tokens).
const AGENT_COLOR: Record<string, string> = {
  pm: "var(--avatar-pm)",
  developer: "var(--accent)",
  qa: "var(--on-air)",
  architect: "var(--thinking)",
  designer: "var(--avatar-designer)",
  "dev-ben": "var(--avatar-user)",
};
function agentColor(agent: string): string {
  return AGENT_COLOR[agent] || "var(--ink-4)";
}
// Distinct palette for the By-room ring (assigned by index).
const ROOM_PALETTE = [
  "var(--accent)",
  "var(--avatar-pm)",
  "var(--on-air)",
  "var(--thinking)",
  "var(--avatar-designer)",
  "var(--avatar-user)",
];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}
function fmtCost(n: number): string {
  return "$" + (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
}
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}
function tokensOf(row: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }): number {
  return row.inputTokens + row.outputTokens + row.cacheRead + row.cacheWrite;
}
function hitRate(inputTokens: number, cacheRead: number): number {
  return inputTokens + cacheRead > 0 ? cacheRead / (inputTokens + cacheRead) : 0;
}

interface UsagePageProps {
  // Fixed room scope (unused in Settings → Usage, which is platform-wide).
  roomId?: string;
}

export function UsagePage({ roomId }: UsagePageProps) {
  const [range, setRange] = useState<RangeDays>(7);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [roomFilter, setRoomFilter] = useState<string | null>(roomId ?? null);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const effectiveRoom = roomId ?? roomFilter;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const from = isoDaysAgo(range);
    const req = effectiveRoom
      ? getRoomUsage(effectiveRoom, { from, agent: agentFilter || undefined })
      : getPlatformUsage({ from, agent: agentFilter || undefined });
    req
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message || err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, roomFilter, agentFilter, roomId, effectiveRoom]);

  // Filter options from a stable platform fetch (entities with data).
  const [agentOptions, setAgentOptions] = useState<string[]>([]);
  const [roomOptions, setRoomOptions] = useState<Array<{ roomId: string; roomName?: string }>>([]);
  useEffect(() => {
    if (roomId) return;
    getPlatformUsage({ from: isoDaysAgo(30) })
      .then((res) => {
        setAgentOptions(res.byAgent.map((a) => a.agent));
        setRoomOptions((res.byRoom || []).map((r) => ({ roomId: r.roomId, roomName: r.roomName })));
      })
      .catch(() => {});
  }, [roomId]);

  const backfilling = data?.backfillStatus === "running";

  // Scope totals for the filter readout.
  const totals = useMemo(() => {
    if (!data) return { tokens: 0, cost: 0, hit: 0 };
    const k = data.kpis;
    return {
      tokens: k.inputTokens + k.outputTokens + k.cacheRead + k.cacheWrite,
      cost: k.cost,
      hit: k.cacheHitRate,
    };
  }, [data]);

  const roomLabel = roomFilter ? roomOptions.find((r) => r.roomId === roomFilter)?.roomName || roomFilter : "All rooms";

  return (
    <div className="w-full">
      {/* Unified filter bar: Room · Agent · Days */}
      <div className="bg-surface-1 border border-line rounded-lg px-4 py-3 mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        {!roomId && (
          <FilterGroup
            label="Room"
            options={[{ id: null, label: "All rooms" }, ...roomOptions.map((r) => ({ id: r.roomId, label: r.roomName || r.roomId }))]}
            value={roomFilter}
            onChange={setRoomFilter}
          />
        )}
        <FilterGroup
          label="Agent"
          options={[{ id: null, label: "All agents" }, ...agentOptions.map((a) => ({ id: a, label: a, color: agentColor(a) }))]}
          value={agentFilter}
          onChange={setAgentFilter}
        />
        <FilterGroup
          label="Days"
          options={([7, 14, 30] as RangeDays[]).map((n) => ({ id: String(n), label: `${n}d` }))}
          value={String(range)}
          onChange={(v) => setRange((Number(v) || 7) as RangeDays)}
          allowNull={false}
        />
        <div className="ml-auto text-[11.5px] text-ink-4 tabular-nums">
          {roomLabel} · {agentFilter || "All agents"} · {range}d
          {data && (
            <>
              {"  —  "}
              {fmtTokens(totals.tokens)} · {fmtCost(totals.cost)} · {Math.round(totals.hit * 100)}% cache hit
            </>
          )}
        </div>
      </div>

      {backfilling && (
        <div className="text-[12px] text-ink-3 mb-3">Building usage index… numbers will fill in shortly.</div>
      )}
      {error && <div className="text-[12px] text-blocked mb-3">Failed to load usage: {error}</div>}

      {loading && !data ? (
        <div className="text-sm text-ink-3 py-12 text-center">Loading…</div>
      ) : data && data.byAgent.length === 0 && data.breakdown.length === 0 ? (
        <EmptyState backfilling={backfilling} />
      ) : data ? (
        <UsageBody
          data={data}
          effectiveRoom={effectiveRoom}
          agentFilter={agentFilter}
          onPickAgent={setAgentFilter}
          onPickRoom={setRoomFilter}
        />
      ) : null}
    </div>
  );
}

function FilterGroup({
  label,
  options,
  value,
  onChange,
  allowNull = true,
}: {
  label: string;
  options: Array<{ id: string | null; label: string; color?: string }>;
  value: string | null;
  onChange: (v: string | null) => void;
  allowNull?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-ink-4 font-semibold w-12">{label}</span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {options.map((o) => {
          const on = value === o.id;
          return (
            <button
              key={o.id ?? "__all"}
              onClick={() => {
                if (!allowNull && o.id === null) return;
                onChange(o.id);
              }}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors cursor-pointer ${
                on ? "text-accent-contrast" : "border-line text-ink-3 hover:text-ink-1"
              }`}
              style={on ? { background: o.color || "var(--accent)", borderColor: o.color || "var(--accent)" } : undefined}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({ backfilling }: { backfilling: boolean }) {
  return (
    <div className="text-center py-16 text-ink-3">
      <div className="text-sm font-medium text-ink-2 mb-1">No usage yet</div>
      <div className="text-xs">
        {backfilling
          ? "The usage index is still building — check back in a moment."
          : "Usage appears here once members start running turns."}
      </div>
    </div>
  );
}

type BreakdownKind = "agent" | "room" | "member";

function UsageBody({
  data,
  effectiveRoom,
  agentFilter,
  onPickAgent,
  onPickRoom,
}: {
  data: UsageResponse;
  effectiveRoom: string | null | undefined;
  agentFilter: string | null;
  onPickAgent: (a: string | null) => void;
  onPickRoom: (r: string) => void;
}) {
  const kind: BreakdownKind = effectiveRoom ? "member" : agentFilter ? "room" : "agent";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <ShareDonut data={data} kind={kind} onPickAgent={onPickAgent} onPickRoom={onPickRoom} />
        <TrendChart series={data.series} agentFilter={agentFilter} />
      </div>
      <DrillTable data={data} kind={kind} onPickAgent={onPickAgent} onPickRoom={onPickRoom} />
    </div>
  );
}

interface Slice {
  id: string;
  label: string;
  value: number;
  color: string;
  clickable: boolean;
}

function buildSlices(data: UsageResponse, kind: BreakdownKind): Slice[] {
  const slices: Slice[] = [];
  if (kind === "member") {
    // member × model rows → aggregate to member (v3 table is per-member, no model col)
    const byMember = new Map<string, { label: string; agent: string; value: number }>();
    for (const b of data.breakdown) {
      const cur = byMember.get(b.memberId) || { label: b.memberName || b.memberId, agent: b.agent || "", value: 0 };
      cur.value += tokensOf(b);
      byMember.set(b.memberId, cur);
    }
    for (const [id, m] of byMember) slices.push({ id, label: m.label, value: m.value, color: agentColor(m.agent), clickable: false });
  } else if (kind === "room") {
    (data.byRoom || []).forEach((r, i) =>
      slices.push({ id: r.roomId, label: r.roomName || r.roomId, value: tokensOf(r), color: ROOM_PALETTE[i % ROOM_PALETTE.length], clickable: true }),
    );
  } else {
    for (const a of data.byAgent) slices.push({ id: a.agent, label: a.agent, value: tokensOf(a), color: agentColor(a.agent), clickable: true });
  }
  return slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
}

function ShareDonut({
  data,
  kind,
  onPickAgent,
  onPickRoom,
}: {
  data: UsageResponse;
  kind: BreakdownKind;
  onPickAgent: (a: string | null) => void;
  onPickRoom: (r: string) => void;
}) {
  const slices = buildSlices(data, kind);
  const total = slices.reduce((acc, s) => acc + s.value, 0) || 1;
  const title = kind === "agent" ? "By agent" : kind === "room" ? "By room" : "By member";
  const R = 15.915;
  let acc = 0;

  const onSlice = (s: Slice) => {
    if (!s.clickable) return;
    if (kind === "agent") onPickAgent(s.id);
    else if (kind === "room") onPickRoom(s.id);
  };

  return (
    <div className="bg-surface-1 border border-line rounded-lg p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-[13px] font-semibold text-ink-1">{title}</h3>
        <span className="text-[11px] text-ink-4">{fmtTokens(total)} tokens</span>
      </div>
      <div className="flex items-center gap-5">
        <svg width="140" height="140" viewBox="0 0 42 42" className="shrink-0 -rotate-90">
          {slices.map((s) => {
            const pct = (s.value / total) * 100;
            if (pct < 0.4) return null;
            const seg = (
              <circle
                key={s.id}
                cx="21"
                cy="21"
                r={R}
                fill="transparent"
                stroke={s.color}
                strokeWidth={5.5}
                strokeDasharray={`${pct} ${100 - pct}`}
                strokeDashoffset={-acc}
                style={{ cursor: s.clickable ? "pointer" : "default" }}
                onClick={() => onSlice(s)}
              />
            );
            acc += pct;
            return seg;
          })}
        </svg>
        <div className="min-w-0 flex-1 space-y-1.5 text-[12.5px]">
          {slices.map((s) => {
            const pct = (s.value / total) * 100;
            return (
              <div key={s.id} className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-sm inline-block shrink-0" style={{ background: s.color }} />
                <button
                  className={`whitespace-nowrap overflow-hidden text-ellipsis text-left ${
                    s.clickable ? "cursor-pointer hover:text-ink-1 hover:underline text-ink-2" : "text-ink-2 cursor-default"
                  }`}
                  onClick={() => onSlice(s)}
                  title={s.label}
                >
                  {s.label}
                </button>
                <span className="ml-auto tabular-nums text-ink-3 shrink-0">{pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Daily stacked columns colored by agent (no model dimension). */
function TrendChart({ series, agentFilter }: { series: UsageSeriesPoint[]; agentFilter: string | null }) {
  // Agents present across the range, for stable stacking + legend.
  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const p of series) for (const a of Object.keys(p.byAgent || {})) set.add(a);
    const list = [...set];
    return agentFilter ? list.filter((a) => a === agentFilter) : list.sort();
  }, [series, agentFilter]);

  const W = Math.max(460, series.length * 30);
  const H = 190;
  const pad = 6;
  const dayTotal = (p: UsageSeriesPoint) => agents.reduce((s, a) => s + (p.byAgent?.[a] || 0), 0);
  const max = Math.max(...series.map(dayTotal), 1);
  const step = series.length ? (W - pad * 2) / series.length : 0;
  const bw = Math.min(20, step * 0.64);

  // X ticks: step back from the last day so the most recent date is always
  // labeled, even spacing (≤8 ticks), no collision.
  const interval = Math.max(1, Math.ceil(series.length / 8));
  const tickIdx: number[] = [];
  for (let i = series.length - 1; i >= 0; i -= interval) tickIdx.unshift(i);

  return (
    <div className="bg-surface-1 border border-line rounded-lg p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-ink-1">History</h3>
        <span className="text-[11px] text-ink-4">tokens per day</span>
      </div>
      {series.length === 0 ? (
        <div className="text-[12px] text-ink-3 py-8 text-center">No data in this range.</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <svg height={H} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]" preserveAspectRatio="none">
              {series.map((p, i) => {
                let y = H;
                const x = pad + i * step + (step - bw) / 2;
                return agents.map((a) => {
                  const v = p.byAgent?.[a] || 0;
                  const h = (v / max) * (H - 14);
                  y -= h;
                  if (h <= 0) return null;
                  return (
                    <rect
                      key={`${p.date}-${a}`}
                      x={x.toFixed(1)}
                      y={y.toFixed(1)}
                      width={bw.toFixed(1)}
                      height={h.toFixed(1)}
                      rx={2}
                      fill={agentColor(a)}
                    >
                      <title>{`${p.date} · ${a}: ${fmtTokens(v)}`}</title>
                    </rect>
                  );
                });
              })}
            </svg>
          </div>
          <div className="relative h-4 mt-1" style={{ minWidth: 420 }}>
            {tickIdx.map((i) => {
              const leftPct = ((pad + i * step + step / 2) / W) * 100;
              return (
                <span
                  key={series[i].date}
                  className="absolute text-[10.5px] text-ink-4 -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${leftPct}%` }}
                >
                  {series[i].date.slice(5)}
                </span>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[11.5px] text-ink-3">
            {agents.map((a) => (
              <span key={a} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: agentColor(a) }} />
                {a}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** 4-column detail table (identity / Tokens / Spend / Cache hit) + Total row. */
function DrillTable({
  data,
  kind,
  onPickAgent,
  onPickRoom,
}: {
  data: UsageResponse;
  kind: BreakdownKind;
  onPickAgent: (a: string | null) => void;
  onPickRoom: (r: string) => void;
}) {
  interface Row {
    id: string;
    label: string;
    color: string;
    tokens: number;
    cost: number;
    hit: number;
    clickable: boolean;
  }
  const rows: Row[] = [];

  if (kind === "member") {
    const byMember = new Map<string, Row>();
    for (const b of data.breakdown) {
      const cur = byMember.get(b.memberId) || {
        id: b.memberId,
        label: b.memberName || b.memberId,
        color: agentColor(b.agent || ""),
        tokens: 0,
        cost: 0,
        hit: 0,
        clickable: false,
        _in: 0,
        _cr: 0,
      } as Row & { _in: number; _cr: number };
      (cur as any)._in += b.inputTokens;
      (cur as any)._cr += b.cacheRead;
      cur.tokens += tokensOf(b);
      cur.cost += b.cost;
      byMember.set(b.memberId, cur);
    }
    for (const r of byMember.values()) {
      r.hit = hitRate((r as any)._in, (r as any)._cr);
      rows.push(r);
    }
  } else if (kind === "room") {
    (data.byRoom || []).forEach((rm, i) =>
      rows.push({
        id: rm.roomId,
        label: rm.roomName || rm.roomId,
        color: ROOM_PALETTE[i % ROOM_PALETTE.length],
        tokens: tokensOf(rm),
        cost: rm.cost,
        hit: hitRate(rm.inputTokens, rm.cacheRead),
        clickable: true,
      }),
    );
  } else {
    for (const a of data.byAgent)
      rows.push({
        id: a.agent,
        label: a.agent,
        color: agentColor(a.agent),
        tokens: tokensOf(a),
        cost: a.cost,
        hit: hitRate(a.inputTokens, a.cacheRead),
        clickable: true,
      });
  }
  rows.sort((a, b) => b.tokens - a.tokens);

  const idHead = kind === "agent" ? "Agent" : kind === "room" ? "Room" : "Member";
  const title = kind === "agent" ? "Agents" : kind === "room" ? "By room" : "Members";
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalHit = data.kpis.cacheHitRate;

  const onRow = (r: Row) => {
    if (!r.clickable) return;
    if (kind === "agent") onPickAgent(r.id);
    else if (kind === "room") onPickRoom(r.id);
  };

  return (
    <div className="bg-surface-1 border border-line rounded-lg">
      <div className="flex items-baseline justify-between px-5 pt-4 pb-1">
        <h3 className="text-[13px] font-semibold text-ink-1">{title}</h3>
        {kind !== "member" && <span className="text-[11px] text-ink-4">click a row to filter</span>}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>{idHead}</Th>
            <Th right>Tokens</Th>
            <Th right>Spend</Th>
            <Th right>Cache hit</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => onRow(r)}
              className={`border-b border-line-soft last:border-0 ${r.clickable ? "cursor-pointer hover:bg-surface-2" : ""}`}
            >
              <Td>
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: r.color }} />
                  <span className="text-ink-1 font-medium">{r.label}</span>
                </span>
              </Td>
              <Td right>{fmtTokens(r.tokens)}</Td>
              <Td right>{fmtCost(r.cost)}</Td>
              <Td right>{Math.round(r.hit * 100)}%</Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line">
            <Td strong>Total</Td>
            <Td right strong>{fmtTokens(totalTokens)}</Td>
            <Td right strong>{fmtCost(totalCost)}</Td>
            <Td right strong>{Math.round(totalHit * 100)}%</Td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`text-[11px] tracking-wide uppercase text-ink-4 font-semibold px-3 py-2 border-b border-line ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
function Td({ children, right, strong }: { children?: React.ReactNode; right?: boolean; strong?: boolean }) {
  return (
    <td className={`px-3 py-2 text-[13px] tabular-nums ${right ? "text-right" : "text-left"} ${strong ? "text-ink-1 font-semibold" : "text-ink-2"}`}>
      {children}
    </td>
  );
}
