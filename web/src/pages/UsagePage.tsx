// Usage — token consumption by identity, room and time (v4 split).
//
// Two views behind a Total | Trend switch (different jobs, different time
// semantics):
//   Total — overall statistics across ANY span (7/30/90d · All time · Custom);
//           share donut + detail table side by side, no chart.
//   Trend — consumption over a BOUNDED range (quick 7/14/30d · custom dates
//           within 180d); full-width agent-stacked columns; >60 days groups
//           weekly for readability.
//
// Filter bar layout (fish): Room · Agent on row one; range/dates on row two.
//
// Breakdown dimension stays unambiguous:
//   room selected            → By member
//   agent selected, no room  → By room
//   neither                  → By agent
import { useEffect, useMemo, useState } from "react";
import {
  getPlatformUsage,
  getRoomUsage,
  type UsageResponse,
} from "../api/client";
import {
  bucketSeries,
  isoDaysAgo,
  minTrendDate,
  resolveTotalQuery,
  resolveTrendQuery,
  tickIndices,
  todayIso,
  type TotalPreset,
  type TrendQuick,
} from "../utils/usage-view";

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

type UsageTab = "total" | "trend";

const TAB_DESC: Record<UsageTab, string> = {
  total: "Overall statistics across any time span — share by identity, drill to room and member.",
  trend: "Consumption trend over a bounded date range — pick any start and end date.",
};

export function UsagePage({ roomId }: UsagePageProps) {
  const [tab, setTab] = useState<UsageTab>("total");
  return (
    <div className="w-full">
      <div className="inline-flex gap-1 rounded-xl border border-line-soft bg-inset p-1 mb-2">
        {(["total", "trend"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg px-4 py-1.5 text-[12.5px] font-semibold whitespace-nowrap transition-colors cursor-pointer ${
              tab === key ? "bg-surface-1 text-ink-1 border border-line-soft shadow-sm" : "text-ink-3 hover:text-ink-1 border border-transparent"
            }`}
          >
            {key === "total" ? "Total" : "Trend"}
          </button>
        ))}
      </div>
      <p className="text-[12.5px] text-ink-3 mb-4">{TAB_DESC[tab]}</p>
      {tab === "total" ? <TotalView roomId={roomId} /> : <TrendView roomId={roomId} />}
    </div>
  );
}

// -- Shared data plumbing --

interface UsageQuery {
  from?: string;
  to?: string;
  agent?: string;
}

function useUsageData(roomId: string | undefined, roomFilter: string | null, query: UsageQuery | null) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const effectiveRoom = roomId ?? roomFilter;

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const req = effectiveRoom
      ? getRoomUsage(effectiveRoom, { from: query.from, to: query.to, agent: query.agent })
      : getPlatformUsage({ from: query.from, to: query.to, agent: query.agent });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query?.from, query?.to, query?.agent, effectiveRoom, roomId]);

  return { data, loading, error, effectiveRoom };
}

/** Filter options from a stable all-time platform fetch (entities with data). */
function useFilterOptions(roomId: string | undefined) {
  const [agentOptions, setAgentOptions] = useState<string[]>([]);
  const [roomOptions, setRoomOptions] = useState<Array<{ roomId: string; roomName?: string }>>([]);
  useEffect(() => {
    if (roomId) return;
    getPlatformUsage()
      .then((res) => {
        setAgentOptions(res.byAgent.map((a) => a.agent));
        setRoomOptions((res.byRoom || []).map((r) => ({ roomId: r.roomId, roomName: r.roomName })));
      })
      .catch(() => {});
  }, [roomId]);
  return { agentOptions, roomOptions };
}

// -- Total view --

function TotalView({ roomId }: UsagePageProps) {
  const [preset, setPreset] = useState<TotalPreset>(30);
  const [customFrom, setCustomFrom] = useState(() => isoDaysAgo(30));
  const [customTo, setCustomTo] = useState(() => todayIso());
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [roomFilter, setRoomFilter] = useState<string | null>(roomId ?? null);
  const { agentOptions, roomOptions } = useFilterOptions(roomId);

  const query = useMemo<UsageQuery | null>(() => {
    if (preset === -1 && (!customFrom || !customTo)) return null;
    const q = resolveTotalQuery(preset, customFrom, customTo);
    return { from: q.from, to: q.to, agent: agentFilter || undefined };
  }, [preset, customFrom, customTo, agentFilter]);
  const rangeLabel = useMemo(() => resolveTotalQuery(preset, customFrom, customTo).label, [preset, customFrom, customTo]);

  const { data, loading, error, effectiveRoom } = useUsageData(roomId, roomFilter, query);
  const roomLabel = roomFilter ? roomOptions.find((r) => r.roomId === roomFilter)?.roomName || roomFilter : "All rooms";

  const totals = useMemo(() => {
    if (!data) return null;
    const k = data.kpis;
    return { tokens: k.inputTokens + k.outputTokens + k.cacheRead + k.cacheWrite, cost: k.cost, hit: k.cacheHitRate };
  }, [data]);

  return (
    <div>
      {/* Filter bar: row 1 Room · Agent; row 2 Range (+ readout) */}
      <div className="bg-surface-1 border border-line rounded-lg px-4 py-3 mb-4 space-y-2.5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {!roomId && (
            <FilterGroup
              label="Room"
              options={[{ id: null, label: "All rooms" }, ...roomOptions.map((r) => ({ id: r.roomId, label: r.roomName || r.roomId }))]}
              value={roomFilter}
              onChange={setRoomFilter}
            />
          )}
          <FilterGroup
            label="Member"
            options={[{ id: null, label: "All members" }, ...agentOptions.map((a) => ({ id: a, label: a, color: agentColor(a) }))]}
            value={agentFilter}
            onChange={setAgentFilter}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line-soft pt-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-ink-4 font-semibold w-12">Range</span>
            <FilterChips
              options={[
                { id: "7", label: "7d" },
                { id: "30", label: "30d" },
                { id: "90", label: "90d" },
                { id: "0", label: "All time" },
                { id: "-1", label: "Custom" },
              ]}
              value={String(preset)}
              onChange={(v) => setPreset(Number(v) as TotalPreset)}
            />
            {preset === -1 && (
              <DateRangeInputs from={customFrom} to={customTo} max={todayIso()} onFrom={setCustomFrom} onTo={setCustomTo} />
            )}
          </div>
          <div className="ml-auto text-[11.5px] text-ink-4 tabular-nums">
            {roomLabel} · {agentFilter || "All members"} · {rangeLabel}
            {totals && (
              <>
                {"  —  "}
                {fmtTokens(totals.tokens)} · {fmtCost(totals.cost)} · {Math.round(totals.hit * 100)}% cache hit
              </>
            )}
          </div>
        </div>
      </div>

      <UsageStates data={data} loading={loading} error={error}>
        {data && (
          <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4">
            <ShareDonut
              data={data}
              kind={breakdownKind(effectiveRoom, agentFilter)}
              rangeLabel={rangeLabel}
              onPickAgent={setAgentFilter}
              onPickRoom={setRoomFilter}
            />
            <DrillTable
              data={data}
              kind={breakdownKind(effectiveRoom, agentFilter)}
              agentFilter={agentFilter}
              roomLabel={roomFilter ? roomLabel : null}
              onPickAgent={setAgentFilter}
              onPickRoom={setRoomFilter}
            />
          </div>
        )}
      </UsageStates>
    </div>
  );
}

// -- Trend view --

function TrendView({ roomId }: UsagePageProps) {
  const [quick, setQuick] = useState<TrendQuick>(7);
  const [customFrom, setCustomFrom] = useState(() => isoDaysAgo(7));
  const [customTo, setCustomTo] = useState(() => todayIso());
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [roomFilter, setRoomFilter] = useState<string | null>(roomId ?? null);
  const { agentOptions, roomOptions } = useFilterOptions(roomId);

  const query = useMemo<UsageQuery | null>(() => {
    if (quick === 0 && (!customFrom || !customTo)) return null;
    const q = resolveTrendQuery(quick, customFrom, customTo);
    return { from: q.from, to: q.to, agent: agentFilter || undefined };
  }, [quick, customFrom, customTo, agentFilter]);
  const span = useMemo(() => resolveTrendQuery(quick, customFrom, customTo), [quick, customFrom, customTo]);

  const { data, loading, error, effectiveRoom } = useUsageData(roomId, roomFilter, query);
  const roomLabel = roomFilter ? roomOptions.find((r) => r.roomId === roomFilter)?.roomName || roomFilter : "All rooms";

  const totals = useMemo(() => {
    if (!data) return null;
    const k = data.kpis;
    return { tokens: k.inputTokens + k.outputTokens + k.cacheRead + k.cacheWrite, cost: k.cost };
  }, [data]);

  return (
    <div>
      {/* Filter bar: row 1 Room · Agent; row 2 Dates (+ readout) */}
      <div className="bg-surface-1 border border-line rounded-lg px-4 py-3 mb-4 space-y-2.5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {!roomId && (
            <FilterGroup
              label="Room"
              options={[{ id: null, label: "All rooms" }, ...roomOptions.map((r) => ({ id: r.roomId, label: r.roomName || r.roomId }))]}
              value={roomFilter}
              onChange={setRoomFilter}
            />
          )}
          <FilterGroup
            label="Member"
            options={[{ id: null, label: "All members" }, ...agentOptions.map((a) => ({ id: a, label: a, color: agentColor(a) }))]}
            value={agentFilter}
            onChange={setAgentFilter}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line-soft pt-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wide text-ink-4 font-semibold w-12">Dates</span>
            <FilterChips
              options={[
                { id: "7", label: "7d" },
                { id: "14", label: "14d" },
                { id: "30", label: "30d" },
                { id: "0", label: "Custom" },
              ]}
              value={String(quick)}
              onChange={(v) => {
                const n = Number(v) as TrendQuick;
                setQuick(n);
                if (n !== 0) {
                  setCustomFrom(isoDaysAgo(n));
                  setCustomTo(todayIso());
                }
              }}
            />
            <DateRangeInputs
              from={quick === 0 ? customFrom : span.from}
              to={quick === 0 ? customTo : span.to}
              min={minTrendDate()}
              max={todayIso()}
              onFrom={(v) => {
                setQuick(0);
                setCustomFrom(v);
              }}
              onTo={(v) => {
                setQuick(0);
                setCustomTo(v);
              }}
            />
          </div>
          <div className="ml-auto text-[11.5px] text-ink-4 tabular-nums">
            {roomLabel} · {agentFilter || "All members"} · {span.from} → {span.to}
            {totals && (
              <>
                {"  —  "}
                {fmtTokens(totals.tokens)} · {fmtCost(totals.cost)}
              </>
            )}
          </div>
        </div>
      </div>

      <UsageStates data={data} loading={loading} error={error}>
        {data && <TrendChart data={data} agentFilter={agentFilter} />}
      </UsageStates>
    </div>
  );
}

// -- Shared UI pieces --

type BreakdownKind = "agent" | "room" | "member";

function breakdownKind(effectiveRoom: string | null | undefined, agentFilter: string | null): BreakdownKind {
  return effectiveRoom ? "member" : agentFilter ? "room" : "agent";
}

function UsageStates({
  data,
  loading,
  error,
  children,
}: {
  data: UsageResponse | null;
  loading: boolean;
  error: string | null;
  children?: React.ReactNode;
}) {
  return (
    <>
      {error && <div className="text-[12px] text-blocked mb-3">Failed to load usage: {error}</div>}
      {loading && !data ? (
        <div className="text-sm text-ink-3 py-12 text-center">Loading…</div>
      ) : data && data.byAgent.length === 0 && data.breakdown.length === 0 ? (
        <EmptyState />
      ) : (
        children
      )}
    </>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16 text-ink-3">
      <div className="text-sm font-medium text-ink-2 mb-1">No usage yet</div>
      <div className="text-xs">
        Usage appears here once members start running turns.
      </div>
    </div>
  );
}

function FilterChips({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: string; label: string; color?: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
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
  );
}

function FilterGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: string | null; label: string; color?: string }>;
  value: string | null;
  onChange: (v: string | null) => void;
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
              onClick={() => onChange(o.id)}
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

function DateRangeInputs({
  from,
  to,
  min,
  max,
  onFrom,
  onTo,
}: {
  from: string;
  to: string;
  min?: string;
  max?: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const cls =
    "bg-surface-2 border border-line rounded-md text-ink-2 text-xs px-2 py-1 outline-none focus:border-accent focus:text-ink-1 [color-scheme:light] dark:[color-scheme:dark]";
  return (
    <span className="flex items-center gap-1.5">
      <input type="date" className={cls} value={from} min={min} max={max} onChange={(e) => onFrom(e.target.value)} />
      <span className="text-ink-4 text-[11px]">→</span>
      <input type="date" className={cls} value={to} min={min} max={max} onChange={(e) => onTo(e.target.value)} />
    </span>
  );
}

// -- Total pieces --

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
    // member × model rows → aggregate to member (table is per-member, no model col)
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
  rangeLabel,
  onPickAgent,
  onPickRoom,
}: {
  data: UsageResponse;
  kind: BreakdownKind;
  rangeLabel: string;
  onPickAgent: (a: string | null) => void;
  onPickRoom: (r: string) => void;
}) {
  const slices = buildSlices(data, kind);
  const total = slices.reduce((acc, s) => acc + s.value, 0) || 1;
  const title = kind === "agent" ? "By member" : kind === "room" ? "By room" : "By member";
  const R = 15.915;
  let acc = 0;

  const onSlice = (s: Slice) => {
    if (!s.clickable) return;
    if (kind === "agent") onPickAgent(s.id);
    else if (kind === "room") onPickRoom(s.id);
  };

  return (
    <div className="bg-surface-1 border border-line rounded-lg p-5 self-start">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-[13px] font-semibold text-ink-1">{title}</h3>
        <span className="text-[11px] text-ink-4">{rangeLabel} share</span>
      </div>
      <div className="flex items-center gap-5">
        <svg width="150" height="150" viewBox="0 0 42 42" className="shrink-0 -rotate-90">
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
          <text x="21" y="20" textAnchor="middle" fill="var(--ink-1)" fontSize="4.6" fontWeight="700" transform="rotate(90 21 21)" className="tabular-nums">
            {fmtTokens(total)}
          </text>
          <text x="21" y="24.5" textAnchor="middle" fill="var(--ink-3)" fontSize="2.4" transform="rotate(90 21 21)">
            tokens
          </text>
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

/** 4-column detail table (identity / Tokens / Spend / Cache hit) + Total row. */
function DrillTable({
  data,
  kind,
  agentFilter,
  roomLabel,
  onPickAgent,
  onPickRoom,
}: {
  data: UsageResponse;
  kind: BreakdownKind;
  agentFilter: string | null;
  roomLabel: string | null;
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

  const idHead = kind === "agent" ? "Member" : kind === "room" ? "Room" : "Member";
  const title = kind === "agent" ? "Members" : kind === "room" ? `${agentFilter} — by room` : `${roomLabel} — members`;
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalHit = data.kpis.cacheHitRate;

  const onRow = (r: Row) => {
    if (!r.clickable) return;
    if (kind === "agent") onPickAgent(r.id);
    else if (kind === "room") onPickRoom(r.id);
  };

  return (
    <div className="bg-surface-1 border border-line rounded-lg self-start">
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

// -- Trend pieces --

/** Full-width stacked columns colored by agent; weekly grouping beyond 60 days. */
function TrendChart({ data, agentFilter }: { data: UsageResponse; agentFilter: string | null }) {
  const series = data.series;
  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const p of series) for (const a of Object.keys(p.byAgent || {})) set.add(a);
    const list = [...set];
    return agentFilter ? list.filter((a) => a === agentFilter) : list.sort();
  }, [series, agentFilter]);

  const { rows, weekly } = useMemo(() => bucketSeries(series, agents), [series, agents]);
  const dayCount = series.length;

  const W = Math.max(560, rows.length * (weekly ? 34 : 26));
  const H = 220;
  const pad = 6;
  const bucketTotal = (r: { per: Record<string, number> }) => agents.reduce((s, a) => s + (r.per[a] || 0), 0);
  const max = Math.max(...rows.map(bucketTotal), 1);
  const step = rows.length ? (W - pad * 2) / rows.length : 0;
  const bw = Math.min(20, step * 0.64);
  const ticks = tickIndices(rows.length);

  return (
    <div className="bg-surface-1 border border-line rounded-lg p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-ink-1">History</h3>
        <span className="text-[11px] text-ink-4">{weekly ? "tokens per week" : "tokens per day"}</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-[12px] text-ink-3 py-8 text-center">No data in this range.</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <svg height={H} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" preserveAspectRatio="none">
              {rows.map((r, i) => {
                let y = H;
                const x = pad + i * step + (step - bw) / 2;
                return agents.map((a) => {
                  const v = r.per[a] || 0;
                  const h = (v / max) * (H - 14);
                  y -= h;
                  if (h <= 0) return null;
                  return (
                    <rect
                      key={`${r.label}-${a}`}
                      x={x.toFixed(1)}
                      y={y.toFixed(1)}
                      width={bw.toFixed(1)}
                      height={h.toFixed(1)}
                      rx={2}
                      fill={agentColor(a)}
                    >
                      <title>{`${r.label}${weekly ? " (week)" : ""} · ${a}: ${fmtTokens(v)}`}</title>
                    </rect>
                  );
                });
              })}
            </svg>
          </div>
          <div className="relative h-4 mt-1" style={{ minWidth: 560 }}>
            {ticks.map((i) => {
              const leftPct = ((pad + i * step + step / 2) / W) * 100;
              return (
                <span
                  key={rows[i].label}
                  className="absolute text-[10.5px] text-ink-4 -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${leftPct}%` }}
                >
                  {rows[i].label.slice(5)}
                </span>
              );
            })}
          </div>
          <div className="flex items-center justify-between mt-3 gap-4 flex-wrap">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
              {agents.map((a) => (
                <span key={a} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: agentColor(a) }} />
                  {a}
                </span>
              ))}
            </div>
            {weekly && <div className="text-[11px] text-ink-4">{dayCount} days · grouped weekly for readability</div>}
          </div>
        </>
      )}
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
