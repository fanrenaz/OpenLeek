"use client";

import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import CandlestickChartRounded from "@mui/icons-material/CandlestickChartRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import {
  Alert, AppBar, Box, Button, Chip, CircularProgress, Divider, FormControl, IconButton,
  InputLabel, MenuItem, Paper, Select, Skeleton, Stack, Tab, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Tabs, Toolbar, Tooltip, Typography,
} from "@mui/material";
import {
  CandlestickSeries, ColorType, HistogramSeries, createChart, type IChartApi, type UTCTimestamp,
} from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { observerPollIntervalMs } from "../../../observer-poll";

type Manifest = { ref: string; roundId: number; financialRevisionRef: string; socialRevisionRef: string };
type Head = {
  runId: string; lifecycle: string; committedRound: number; configuredRounds: number;
  failure?: { category: string; message: string }; manifest: Manifest | null;
};
type Candle = { roundId: number; open: number; high: number; low: number; close: number; volume: number };
type Level = { price: number; quantity: number; orderCount: number };
type Snapshot = {
  revision: { ref: string; roundId: number };
  quote: { symbol: string; tickSize: number; lastPrice: number; bestBid: number; bestAsk: number; bidSize: number; askSize: number };
  candles: Candle[];
  orderBook: { bids: Level[]; asks: Level[] };
  delta: { lastPrice: number; bestBid: number; bestAsk: number; newTradeCount: number; addedOrderSequences: number[]; removedOrderSequences: number[] };
};
type Trade = { tradeSequence: number; roundId: number; price: number; quantity: number; buyOrderSequence: number | null; sellOrderSequence: number | null };
type Order = { orderSequence: number; side: "buy" | "sell"; limitPrice: number; quantity: number; remainingQuantity: number; timeInForce: string; expiresAtRound?: number };

const TERMINAL = new Set(["completed", "cancelled", "failed"]);

export function FinancialObserverClient({ runId }: { runId: string }) {
  const [head, setHead] = useState<Head>();
  const [rounds, setRounds] = useState<Manifest[]>([]);
  const [selected, setSelected] = useState<Manifest>();
  const [following, setFollowing] = useState(true);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tab, setTab] = useState<"trades" | "orders">("trades");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const selectedRef = useRef<string | undefined>(undefined);

  const loadRounds = useCallback(async () => {
    const value = await requestJson<{ items: Array<{ roundId: number; manifestRef: string; financialRevisionRef: string; socialRevisionRef: string }> }>(
      `/api/observer/runs/${encodeURIComponent(runId)}/rounds?limit=200`,
    );
    const items = value.items.map(({ manifestRef, ...item }) => ({ ...item, ref: manifestRef }));
    setRounds(items);
    return items;
  }, [runId]);

  const loadRevision = useCallback(async (manifest: Manifest) => {
    if (selectedRef.current === manifest.financialRevisionRef) return;
    setLoading(true);
    const query = `runId=${encodeURIComponent(runId)}&revisionRef=${encodeURIComponent(manifest.financialRevisionRef)}`;
    try {
      const [nextSnapshot, tradePage, orderPage] = await Promise.all([
        requestJson<Snapshot>(`/contexts/financial/observer-api?${query}&view=snapshot&depth=20`),
        requestJson<{ items: Trade[] }>(`/contexts/financial/observer-api?${query}&view=trades&limit=200`),
        requestJson<{ items: Order[] }>(`/contexts/financial/observer-api?${query}&view=orders&limit=200`),
      ]);
      selectedRef.current = manifest.financialRevisionRef;
      setSnapshot(nextSnapshot);
      setTrades(tradePage.items);
      setOrders(orderPage.items);
      setSelected(manifest);
      setError("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  const loadHead = useCallback(async () => {
    try {
      const next = await requestJson<Head>(`/api/observer/runs/${encodeURIComponent(runId)}/head`);
      setHead(next);
      if (next.manifest && following) {
        if (selectedRef.current !== next.manifest.financialRevisionRef) {
          const items = await loadRounds();
          const manifest = items.find((item) => item.financialRevisionRef === next.manifest?.financialRevisionRef) ?? next.manifest;
          await loadRevision(manifest);
        }
      } else if (!next.manifest) {
        setLoading(false);
      }
    } catch (reason) {
      setError(message(reason));
      setLoading(false);
    }
  }, [following, loadRevision, loadRounds, runId]);

  useEffect(() => { void loadRounds().then(() => loadHead()); }, [loadHead, loadRounds]);
  useEffect(() => {
    if (!following || (head && TERMINAL.has(head.lifecycle))) return;
    const timer = setInterval(() => void loadHead(), observerPollIntervalMs);
    return () => clearInterval(timer);
  }, [following, head, loadHead]);

  const chooseRound = (revisionRef: string) => {
    const manifest = rounds.find((item) => item.financialRevisionRef === revisionRef);
    if (!manifest) return;
    setFollowing(false);
    void loadRevision(manifest);
  };
  const followLatest = () => {
    selectedRef.current = undefined;
    setFollowing(true);
    void loadHead();
  };

  return <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
    <AppBar color="transparent" elevation={0} position="sticky" sx={{ borderBottom: 1, borderColor: "divider", backdropFilter: "blur(18px)", bgcolor: "rgba(11,14,17,.9)" }}>
      <Toolbar sx={{ gap: 1.5 }}>
        <Tooltip title="Back to Run"><IconButton component="a" href={`/runs/${encodeURIComponent(runId)}`}><ArrowBackRounded /></IconButton></Tooltip>
        <CandlestickChartRounded color="primary" />
        <Box sx={{ minWidth: 0, flex: 1 }}><Typography sx={{ fontWeight: 800 }}>OpenLeek Market</Typography><Typography color="text.secondary" noWrap variant="caption">{runId}</Typography></Box>
        <Chip color={following ? "success" : "default"} label={following ? "Following latest" : `Round ${selected?.roundId ?? "—"}`} size="small" variant="outlined" />
        {!following && <Button onClick={followLatest} startIcon={<RefreshRounded />} variant="outlined">Follow latest</Button>}
      </Toolbar>
    </AppBar>

    <Box component="main" sx={{ p: { xs: 1.5, md: 2.5 }, maxWidth: 1800, mx: "auto" }}>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {head?.failure && <Alert severity="warning" sx={{ mb: 2 }}>{head.failure.category}: {head.failure.message}</Alert>}
      {!head?.manifest && !error && <Paper sx={{ p: 5, textAlign: "center" }}><CircularProgress size={28} /><Typography sx={{ mt: 2 }}>Waiting for the first committed round…</Typography></Paper>}
      {head?.manifest && <>
        <MarketHeader snapshot={snapshot} head={head} rounds={rounds} selected={selected} onRound={chooseRound} loading={loading} />
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 3fr) minmax(310px, 1fr)" }, gap: 1.5, mt: 1.5 }}>
          <Paper sx={{ minHeight: 500, p: 1.5 }} variant="outlined">
          {snapshot ? <MarketChart candles={snapshot.candles} symbol={snapshot.quote.symbol} tickSize={snapshot.quote.tickSize} /> : <Skeleton height={470} variant="rounded" />}
          </Paper>
          <OrderBook snapshot={snapshot} loading={loading} />
        </Box>
        <Paper sx={{ mt: 1.5 }} variant="outlined">
          <Tabs value={tab} onChange={(_, value: "trades" | "orders") => setTab(value)}>
            <Tab label={`Trades (${trades.length})`} value="trades" />
            <Tab label={`Active orders (${orders.length})`} value="orders" />
          </Tabs>
          <Divider />
          {tab === "trades" ? <TradeTable trades={trades} {...(selected === undefined ? {} : { currentRound: selected.roundId })} /> : <OrderTable orders={orders} added={new Set(snapshot?.delta.addedOrderSequences ?? [])} />}
        </Paper>
      </>}
    </Box>
  </Box>;
}

function MarketHeader({ snapshot, head, rounds, selected, onRound, loading }: {
  snapshot: Snapshot | undefined; head: Head; rounds: Manifest[]; selected: Manifest | undefined;
  onRound(value: string): void; loading: boolean;
}) {
  const priceDelta = snapshot?.delta.lastPrice ?? 0;
  const color = priceDelta > 0 ? "success.main" : priceDelta < 0 ? "error.main" : "text.primary";
  const spread = snapshot ? Math.max(0, snapshot.quote.bestAsk - snapshot.quote.bestBid) : 0;
  return <Paper sx={{ px: 2, py: 1.5 }} variant="outlined">
    <Stack direction={{ xs: "column", md: "row" }} sx={{ alignItems: { xs: "stretch", md: "center" }, gap: 2 }}>
      <Box sx={{ minWidth: 150 }}><Typography color="text.secondary" variant="caption">{snapshot?.quote.symbol ?? "ASSET"}</Typography><Typography color={color} sx={{ fontSize: "1.8rem", fontWeight: 800 }}>{loading ? "…" : number(snapshot?.quote.lastPrice)}</Typography></Box>
      <Metric label="Round change" value={signed(priceDelta)} color={color} />
      <Metric label="Best bid" value={number(snapshot?.quote.bestBid)} color="success.main" />
      <Metric label="Best ask" value={number(snapshot?.quote.bestAsk)} color="error.main" />
      <Metric label="Spread" value={number(spread)} />
      <Metric label="New trades" value={number(snapshot?.delta.newTradeCount)} />
      <Box sx={{ flex: 1 }} />
      <FormControl size="small" sx={{ minWidth: 210 }}><InputLabel>Committed round</InputLabel><Select label="Committed round" value={selected?.financialRevisionRef ?? ""} onChange={(event) => onRound(event.target.value)}>
        {rounds.map((item) => <MenuItem key={item.ref} value={item.financialRevisionRef}>Round {item.roundId}</MenuItem>)}
      </Select></FormControl>
      <Chip label={`${head.committedRound} / ${head.configuredRounds}`} size="small" />
    </Stack>
  </Paper>;
}

function Metric({ label, value, color = "text.primary" }: { label: string; value: string; color?: string }) {
  return <Box><Typography color="text.secondary" variant="caption">{label}</Typography><Typography color={color} sx={{ fontFamily: "monospace", fontWeight: 700 }}>{value}</Typography></Box>;
}

function MarketChart({ candles, symbol, tickSize }: { candles: Candle[]; symbol: string; tickSize: number }) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | undefined>(undefined);
  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      height: 460,
      layout: { background: { type: ColorType.Solid, color: "#11161c" }, textColor: "#848e9c", attributionLogo: true },
      grid: { vertLines: { color: "rgba(132,142,156,.08)" }, horzLines: { color: "rgba(132,142,156,.08)" } },
      localization: { timeFormatter: (time: unknown) => `Round ${Math.max(0, Math.round(Number(time) / 86_400) - 1)}` },
      timeScale: { tickMarkFormatter: (time: unknown) => `R${Math.max(0, Math.round(Number(time) / 86_400) - 1)}`, borderColor: "rgba(132,142,156,.2)" },
      rightPriceScale: { borderColor: "rgba(132,142,156,.2)" },
    });
    const precision = Math.min(8, Math.max(0, (tickSize.toString().split(".")[1] ?? "").length));
    const series = chart.addSeries(CandlestickSeries, { upColor: "#0ecb81", downColor: "#f6465d", wickUpColor: "#0ecb81", wickDownColor: "#f6465d", borderVisible: false, priceFormat: { type: "price", precision, minMove: tickSize } });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume" });
    volume.priceScale().applyOptions({ scaleMargins: { top: .82, bottom: 0 } });
    const time = (roundId: number) => ((roundId + 1) * 86_400) as UTCTimestamp;
    series.setData(candles.map((item) => ({ time: time(item.roundId), open: item.open, high: item.high, low: item.low, close: item.close })));
    volume.setData(candles.map((item) => ({ time: time(item.roundId), value: item.volume, color: item.close >= item.open ? "rgba(14,203,129,.5)" : "rgba(246,70,93,.5)" })));
    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = undefined; };
  }, [candles, symbol, tickSize]);
  return <Box ref={container} sx={{ width: "100%", height: 460 }} aria-label={`${symbol} candlestick chart`} />;
}

function OrderBook({ snapshot, loading }: { snapshot: Snapshot | undefined; loading: boolean }) {
  const asks = [...(snapshot?.orderBook.asks ?? [])].reverse();
  const bids = snapshot?.orderBook.bids ?? [];
  const max = Math.max(1, ...[...asks, ...bids].map((level) => level.quantity));
  return <Paper sx={{ overflow: "hidden" }} variant="outlined">
    <Box sx={{ p: 1.5 }}><Typography sx={{ fontWeight: 750 }}>Order book</Typography><Typography color="text.secondary" variant="caption">Committed public depth</Typography></Box>
    <Divider />
    <BookHeader />
    {loading && !snapshot ? <Stack sx={{ p: 2, gap: 1 }}>{Array.from({ length: 12 }, (_, index) => <Skeleton key={index} />)}</Stack> : <>
      {asks.map((level) => <BookRow key={`a:${level.price}`} level={level} max={max} side="ask" />)}
      <Box sx={{ px: 1.5, py: 1, borderBlock: 1, borderColor: "divider" }}><Typography sx={{ fontFamily: "monospace", fontWeight: 800 }}>{number(snapshot?.quote.lastPrice)}</Typography></Box>
      {bids.map((level) => <BookRow key={`b:${level.price}`} level={level} max={max} side="bid" />)}
    </>}
  </Paper>;
}

function BookHeader() {
  return <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", px: 1.5, py: .75 }}><Typography color="text.secondary" variant="caption">Price</Typography><Typography align="right" color="text.secondary" variant="caption">Size</Typography><Typography align="right" color="text.secondary" variant="caption">Orders</Typography></Box>;
}
function BookRow({ level, max, side }: { level: Level; max: number; side: "bid" | "ask" }) {
  return <Box sx={{ position: "relative", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", px: 1.5, py: .45, fontFamily: "monospace", fontSize: ".78rem", "&::before": { content: '""', position: "absolute", inset: 0, left: `${100 - (level.quantity / max) * 100}%`, bgcolor: side === "bid" ? "rgba(14,203,129,.10)" : "rgba(246,70,93,.10)" } }}>
    <Box sx={{ color: side === "bid" ? "success.main" : "error.main", zIndex: 1 }}>{level.price}</Box><Box sx={{ textAlign: "right", zIndex: 1 }}>{level.quantity}</Box><Box sx={{ textAlign: "right", zIndex: 1 }}>{level.orderCount}</Box>
  </Box>;
}

function TradeTable({ trades, currentRound }: { trades: Trade[]; currentRound?: number }) {
  return <TableContainer sx={{ maxHeight: 360 }}><Table size="small" stickyHeader><TableHead><TableRow><TableCell>Sequence</TableCell><TableCell>Round</TableCell><TableCell align="right">Price</TableCell><TableCell align="right">Quantity</TableCell></TableRow></TableHead><TableBody>
    {trades.map((trade) => <TableRow key={trade.tradeSequence} sx={trade.roundId === currentRound ? { bgcolor: "rgba(240,185,11,.06)" } : undefined}><TableCell>{trade.tradeSequence}</TableCell><TableCell>{trade.roundId}</TableCell><TableCell align="right">{trade.price}</TableCell><TableCell align="right">{trade.quantity}</TableCell></TableRow>)}
    {!trades.length && <EmptyRow label="No public trades in this revision." />}
  </TableBody></Table></TableContainer>;
}
function OrderTable({ orders, added }: { orders: Order[]; added: Set<number> }) {
  return <TableContainer sx={{ maxHeight: 360 }}><Table size="small" stickyHeader><TableHead><TableRow><TableCell>Sequence</TableCell><TableCell>Side</TableCell><TableCell align="right">Price</TableCell><TableCell align="right">Remaining</TableCell><TableCell>TIF</TableCell></TableRow></TableHead><TableBody>
    {orders.map((order) => <TableRow key={order.orderSequence} sx={added.has(order.orderSequence) ? { bgcolor: "rgba(240,185,11,.06)" } : undefined}><TableCell>{order.orderSequence}</TableCell><TableCell sx={{ color: order.side === "buy" ? "success.main" : "error.main" }}>{order.side.toUpperCase()}</TableCell><TableCell align="right">{order.limitPrice}</TableCell><TableCell align="right">{order.remainingQuantity} / {order.quantity}</TableCell><TableCell>{order.timeInForce.toUpperCase()}</TableCell></TableRow>)}
    {!orders.length && <EmptyRow label="No active public limit orders." />}
  </TableBody></Table></TableContainer>;
}
function EmptyRow({ label }: { label: string }) { return <TableRow><TableCell align="center" colSpan={5} sx={{ color: "text.secondary", py: 4 }}>{label}</TableCell></TableRow>; }

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const value = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value as T;
}
function message(reason: unknown) { return reason instanceof Error ? reason.message : "Observer request failed"; }
function number(value: number | undefined) { return value === undefined ? "—" : new Intl.NumberFormat("en-US").format(value); }
function signed(value: number) { return value > 0 ? `+${number(value)}` : number(value); }
