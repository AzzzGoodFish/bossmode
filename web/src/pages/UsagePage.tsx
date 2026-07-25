// Usage — token consumption by identity, room and time.
//
// Rendered inside Settings → Usage (integrated into the product shell, not a
// standalone page). The explicit Room/Agent filters are the single source of
// truth; the donut/table also let you drill as a shortcut but always sync back
// to the filter state. Data comes from the SQLite-backed usage API (S2):
//   - platform:   GET /api/usage           (+ byRoom)
//   - single-room GET /api/rooms/:id/usage
// Historical rows carry model="unknown" (pre-stamp) — shown honestly.
import { useEffect, useMemo, useState } from "react";
import {
  getPlatformUsage,
  getRoomUsage,
  type UsageResponse,
  type UsageAgentRow,
  type UsageRoomRow,
  type UsageBreakdownRow,
  type UsageSeriesPoint,
} from "../api/client";

type RangeDays = 7 | 14 | 30;

// Agent identity → chart color, reusing the product's avatar/status tokens so
// the page is theme-aware. Unknown agents fall back to a neutral ink.
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

// Distinct palette for the By-room ring so multiple rooms are visually separable
// (assigned by index; falls back to cycling). Reuses theme tokens.
const ROOM_PALETTE = [
  "var(--accent)",
  "var(--avatar-pm)",
  "var(--on-air)",
  "var(--thinking)",
  "var(--avatar-designer)",
  "var(--avatar-user)",
];
function roomColor(index: number): string {
  return ROOM_PALETTE[index % ROOM_PALETTE.length];
}

function tokensOf(row: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }): number {
  return row.inputTokens + row.outputTokens + row.cacheRead + row.cacheWrite;
}
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

interface UsagePageProps {
  // When roomId is set, the page scopes to a single room (Room filter locked).
  // In Settings → Usage it is undefined → platform-wide.
  roomId?: string;
}

export function UsagePage({ roomId }: UsagePageProps) {
  const [range, setRange] = useState<RangeDays>(7);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [roomFilter, setRoomFilter] = useState<string | null>(roomId ?? null);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch whenever range / filters change. Platform vs single-room chosen by the
  // effective room scope: an explicit room filter (or fixed roomId) → room API.
  // The agent filter is passed through in both modes now (room API supports it).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const from = isoDaysAgo(range);
    const effectiveRoom = roomId ?? roomFilter;
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
  }, [range, roomFilter, agentFilter, roomId]);

  // Available filter options come from the platform response (entities with
  // data). We keep a stable list by fetching platform data once for the pickers.
  const [agentOptions, setAgentOptions] = useState<string[]>([]);
  const [roomOptions, setRoomOptions] = useState<UsageRoomRow[]>([]);
  useEffect(() => {
    if (roomId) return; // single-room mode: no room picker
    getPlatformUsage({ from: isoDaysAgo(30) })
      .then((res) => {
        setAgentOptions(res.byAgent.map((a) => a.agent));
        setRoomOptions(res.byRoom || []);
      })
      .catch(() => {
        /* pickers stay empty; honest */
      });
  }, [roomId]);

  const backfilling = data?.backfillStatus === "running";

  return (
    <div className="w-full">
      {/* Range toggle */}
      <div className="flex items-center justify-end gap-2 mb-4">
        {([7, 14, 30] as RangeDays[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`text-xs px-2.5 py-1 rounded-md border transition-colors cursor-pointer ${
              range === r ? "bg-accent border-accent text-accent-contrast" : "border-line text-ink-3 hover:text-ink-1"
            }`}
          >
            {r}d
          </button>
        ))}
      </div>

      {/* Explicit filter bar (single source of truth) */}
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
        <div className="ml-auto text-[11.5px] text-ink-4">
          {(roomFilter ? roomOptions.find((r) => r.roomId === roomFilter)?.roomName || roomFilter : "All rooms")}
          {" · "}
          {agentFilter || "All agents"}
          {" · "}
          {range}d
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
          effectiveRoom={roomId ?? roomFilter}
          agentFilter={agentFilter}
          onPickAgent={(a) => setAgentFilter(a)}
          onPickRoom={(r) => setRoomFilter(r)}
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
}: {
  label: string;
  options: Array<{ id: string | null; label: string; color?: string }>;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-ink-4 font-semibold">{label}</span>
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
  const kpis = data.kpis;
  const kpiCards: Array<[string, string, string]> = [
    ["Total tokens", fmtTokens(kpis.inputTokens + kpis.outputTokens + kpis.cacheRead + kpis.cacheWrite), "input + output + cache"],
    ["Spend", fmtCost(kpis.cost), "recorded per-turn cost"],
    ["Cache hit", Math.round(kpis.cacheHitRate * 100) + "%", "cacheRead / (input + cacheRead)"],
    ["Turns", kpis.turns.toLocaleString(), "agent turns in range"],
  ];

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpiCards.map(([k, v, s]) => (
          <div key={k} className="bg-surface-1 border border-line rounded-lg px-4 py-3.5">
            <div className="text-[11px] text-ink-4 uppercase tracking-wide">{k}</div>
            <div className="text-[22px] font-bold tabular-nums mt-0.5 text-ink-1">{v}</div>
            <div className="text-[11px] text-ink-3 mt-0.5">{s}</div>
          </div>
        ))}
      </div>

      {/* Donut (identity/room share) + trend */}
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <ShareDonut
          data={data}
          effectiveRoom={effectiveRoom}
          agentFilter={agentFilter}
          onPickAgent={onPickAgent}
          onPickRoom={onPickRoom}
        />
        <TrendChart series={data.series} />
      </div>

      {/* Drill table */}
      <DrillTable data={data} effectiveRoom={effectiveRoom} agentFilter={agentFilter} onPickAgent={onPickAgent} />
    </div>
  );
}

/**
 * The donut shows the current breakdown dimension:
 *   platform, no agent  → By agent (identity share)
 *   platform, agent set → By room  (where that agent works)
 *   single room         → By member
 */
function ShareDonut({
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
  type Slice = { id: string; label: string; value: number; color: string; clickable: boolean };
  let title = "By agent";
  let why = "Which identities consume the most — informs model assignment.";
  const slices: Slice[] = [];

  if (effectiveRoom) {
    title = "By member";
    why = "Member split inside this room.";
    for (const b of data.breakdown) {
      slices.push({
        id: b.memberId,
        label: b.memberName || b.memberId,
        value: tokensOf(b),
        color: agentColor(b.agent || ""),
        clickable: false,
      });
    }
  } else if (agentFilter && data.byRoom) {
    title = "By room";
    why = "Where this agent's consumption happens.";
    for (const r of data.byRoom) {
      slices.push({
        id: r.roomId,
        label: r.roomName || r.roomId,
        value: tokensOf(r),
        color: roomColor(data.byRoom.indexOf(r)),
        clickable: true,
      });
    }
  } else {
    for (const a of data.byAgent) {
      slices.push({
        id: a.agent,
        label: a.agent,
        value: tokensOf(a),
        color: agentColor(a.agent),
        clickable: true,
      });
    }
  }

  const sorted = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((acc, s) => acc + s.value, 0) || 1;

  const R = 15.915;
  let acc = 0;

  const onSlice = (s: Slice) => {
    if (!s.clickable) return;
    if (!effectiveRoom && !agentFilter) onPickAgent(s.id);
    else if (!effectiveRoom && agentFilter) onPickRoom(s.id);
  };

  return (
    <div className="bg-surface-1 border border-line rounded-lg p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-[13px] font-semibold text-ink-1">{title}</h3>
        <span className="text-[11px] text-ink-4">share</span>
      </div>
      <p className="text-[11.5px] text-ink-3 mb-4">{why}</p>
      <div className="flex items-center gap-5">
        <svg width="140" height="140" viewBox="0 0 42 42" className="shrink-0 -rotate-90">
          {sorted.map((s) => {
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
          {sorted.map((s) => {
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

/** Stacked daily columns, one stack per date, colored by model bucket. */
function TrendChart({ series }: { series: UsageSeriesPoint[] }) {
  // Collect model keys across the range for stable stacking + legend.
  const models = useMemo(() => {
    const set = new Set<string>();
    for (const p of series) for (const m of Object.keys(p.byModel)) set.add(m);
    return [...set].sort();
  }, [series]);

  const modelColor = (m: string, i: number): string => {
    if (m === "unknown") return "var(--ink-4)";
    const palette = ["var(--accent)", "var(--avatar-pm)", "var(--on-air)", "var(--thinking)", "var(--avatar-designer)", "var(--avatar-user)"];
    return palette[i % palette.length];
  };

  const dayValue = (p: UsageSeriesPoint, m: string): number => {
    const b = p.byModel[m];
    if (!b) return 0;
    return b.inputTokens + b.outputTokens + b.cacheRead;
  };

  const W = Math.max(460, series.length * 30);
  const H = 190;
  const pad = 4;
  const max = Math.max(
    ...series.map((p) => models.reduce((s, m) => s + dayValue(p, m), 0)),
    1,
  );
  const step = series.length ? (W - pad * 2) / series.length : 0;
  const bw = Math.min(22, step * 0.62);

  return (
    <div className="bg-surface-1 border border-line rounded-lg p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-[13px] font-semibold text-ink-1">History</h3>
        <span className="text-[11px] text-ink-4">per day · stacked by model</span>
      </div>
      <p className="text-[11.5px] text-ink-3 mb-3">Work rhythm over time — heavy days vs idle days.</p>
      {series.length === 0 ? (
        <div className="text-[12px] text-ink-3 py-8 text-center">No data in this range.</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <svg height={H} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]" preserveAspectRatio="none">
              {series.map((p, i) => {
                let y = H;
                const x = pad + i * step + (step - bw) / 2;
                return models.map((m, mi) => {
                  const v = dayValue(p, m);
                  const h = (v / max) * (H - 14);
                  y -= h;
                  if (h <= 0) return null;
                  return (
                    <rect
                      key={`${p.date}-${m}`}
                      x={x.toFixed(1)}
                      y={y.toFixed(1)}
                      width={bw}
                      height={Math.max(h, 0.5).toFixed(1)}
                      rx={2}
                      fill={modelColor(m, mi)}
                    >
                      <title>{`${p.date} · ${m === "unknown" ? "unknown (history)" : m}: ${fmtTokens(v)}`}</title>
                    </rect>
                  );
                });
              })}
            </svg>
          </div>
          {/* X axis: a tick roughly every ceil(n/8) days so labels are readable
              across 7/14/30d instead of only first+last. */}
          <div className="relative h-4 mt-1" style={{ minWidth: 420 }}>
            {series.map((p, i) => {
              const tickEvery = Math.max(1, Math.ceil(series.length / 8));
              if (i % tickEvery !== 0 && i !== series.length - 1) return null;
              const leftPct = ((pad + i * step + step / 2) / W) * 100;
              return (
                <span
                  key={p.date}
                  className="absolute text-[10.5px] text-ink-4 -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${leftPct}%` }}
                >
                  {p.date.slice(5)}
                </span>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[11.5px] text-ink-3">
            {models.map((m, mi) => (
              <span key={m} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: modelColor(m, mi) }} />
                {m === "unknown" ? "unknown (history)" : m}
              </span>
            ))}
          </div>
          {models.includes("unknown") && (
            <p className="text-[11px] text-ink-4 mt-2 leading-relaxed">
              <span className="font-medium">unknown (history)</span> = turns recorded before 0.19.1, when usage events
              did not carry a model. New turns are stamped with their model.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Drill table: agents (platform) or members (single room). */
function DrillTable({
  data,
  effectiveRoom,
  agentFilter,
  onPickAgent,
}: {
  data: UsageResponse;
  effectiveRoom: string | null | undefined;
  agentFilter: string | null;
  onPickAgent: (a: string | null) => void;
}) {
  // Single room → member×model rows; platform → agent rows. Tokens is the
  // primary metric; Spend is a column (no separate spend view).
  if (effectiveRoom) {
    const rows = [...data.breakdown].sort((a, b) => tokensOf(b) - tokensOf(a));
    const total = rows.reduce((s, r) => s + tokensOf(r), 0) || 1;
    return (
      <TableCard title="Members" sub="member × model in this room">
        <thead>
          <Tr head>
            <Th>Member</Th>
            <Th>Agent</Th>
            <Th>Model</Th>
            <Th right>Tokens</Th>
            <Th right>Spend</Th>
            <Th right>Share</Th>
            <Th right>Cache hit</Th>
          </Tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tok = tokensOf(r);
            const pct = (tok / total) * 100;
            const hit = r.inputTokens + r.cacheRead > 0 ? r.cacheRead / (r.inputTokens + r.cacheRead) : 0;
            return (
              <Tr key={`${r.memberId}-${r.model}`}>
                <Td strong>{r.memberName || r.memberId}</Td>
                <Td dim>{r.agent || "—"}</Td>
                <Td dim>{r.model === "unknown" ? "unknown (history)" : r.model}</Td>
                <Td right>{fmtTokens(tok)}</Td>
                <Td right>{fmtCost(r.cost)}</Td>
                <Td right>{pct.toFixed(1)}%</Td>
                <Td right>{Math.round(hit * 100)}%</Td>
              </Tr>
            );
          })}
        </tbody>
      </TableCard>
    );
  }

  // Platform: aggregate to agent rows (byAgent already does this).
  const rows = [...data.byAgent].sort((a, b) => tokensOf(b) - tokensOf(a));
  const total = rows.reduce((s, r) => s + tokensOf(r), 0) || 1;
  return (
    <TableCard title="Agents" sub={agentFilter ? "filtered to one agent · click a row to toggle" : "click a row to filter to that agent"}>
      <thead>
        <Tr head>
          <Th>Agent</Th>
          <Th right>Tokens</Th>
          <Th right>Spend</Th>
          <Th right>Share</Th>
          <Th right>Cache hit</Th>
          <Th />
        </Tr>
      </thead>
      <tbody>
        {rows.map((a) => {
          const tok = tokensOf(a);
          const pct = (tok / total) * 100;
          const hit = a.inputTokens + a.cacheRead > 0 ? a.cacheRead / (a.inputTokens + a.cacheRead) : 0;
          const selected = agentFilter === a.agent;
          return (
            <Tr key={a.agent} clickable onClick={() => onPickAgent(selected ? null : a.agent)} selected={selected}>
              <Td strong>
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: agentColor(a.agent) }} />
                  {a.agent}
                </span>
              </Td>
              <Td right>{fmtTokens(tok)}</Td>
              <Td right>{fmtCost(a.cost)}</Td>
              <Td right>{pct.toFixed(1)}%</Td>
              <Td right>{Math.round(hit * 100)}%</Td>
              <Td>
                <div className="h-1.5 rounded bg-surface-3 overflow-hidden" style={{ width: "100%" }}>
                  <div className="h-full rounded" style={{ width: `${pct}%`, background: agentColor(a.agent) }} />
                </div>
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </TableCard>
  );
}

function TableCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-1 border border-line rounded-lg">
      <div className="flex items-baseline justify-between px-5 pt-4 pb-1">
        <h3 className="text-[13px] font-semibold text-ink-1">{title}</h3>
        <span className="text-[11px] text-ink-4">{sub}</span>
      </div>
      <table className="w-full border-collapse">{children}</table>
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
function Tr({
  children,
  head,
  clickable,
  onClick,
  selected,
}: {
  children: React.ReactNode;
  head?: boolean;
  clickable?: boolean;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <tr
      onClick={onClick}
      className={`${head ? "" : "border-b border-line-soft last:border-0"} ${
        clickable ? "cursor-pointer hover:bg-surface-2" : ""
      } ${selected ? "bg-surface-2" : ""}`}
    >
      {children}
    </tr>
  );
}
function Td({ children, right, strong, dim }: { children?: React.ReactNode; right?: boolean; strong?: boolean; dim?: boolean }) {
  return (
    <td
      className={`px-3 py-2 text-[13px] tabular-nums ${right ? "text-right" : "text-left"} ${
        strong ? "text-ink-1 font-medium" : dim ? "text-ink-3" : "text-ink-2"
      }`}
    >
      {children}
    </td>
  );
}
