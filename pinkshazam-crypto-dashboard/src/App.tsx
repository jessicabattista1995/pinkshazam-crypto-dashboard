import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  ResponsiveContainer, ComposedChart, LineChart, AreaChart, BarChart, Line, Area, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import {
  LayoutDashboard, Bitcoin, Hexagon, Shield, FileText, Database, BookOpen,
  Upload, Download, RotateCcw, Menu, X, AlertTriangle, Camera, Check,
} from "lucide-react";
import btcCsv from "./data/Bitcoin_10_11_2024-10_11_2026_historical_data_coinmarketcap.csv?raw";
import ethCsv from "./data/Ethereum_10_11_2024-10_11_2026_historical_data_coinmarketcap.csv?raw";

/* ==========================================================================
   PinkShazam | Crypto Market Intelligence
   Long-Term Market Research & Data Analytics

   Frequency: MONTHLY. One observation per calendar month, never treated as daily.
   Data policy: every figure is computed from CSV files. The two CoinMarketCap
   monthly exports supplied for this project live in src/data and are loaded
   unchanged at start-up (see BUNDLED at the bottom of this file). They can be
   replaced through the uploader. Nothing is generated, interpolated or filled in.
   ========================================================================== */

/* ----------------------------- design tokens ----------------------------- */
const C = {
  bg: "#0B0D13", surface: "#151821", raised: "#1B1F2B", border: "#252A3A",
  text: "#E7E9F0", muted: "#8F95A8", faint: "#5C6277",
  pink: "#EC4899", purple: "#8B5CF6", up: "#22C55E", down: "#EF4444",
  amber: "#F5B544", slate: "#A7AEC2",
};
const FONT = 'Inter, "SF Pro Text", "Segoe UI", system-ui, -apple-system, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const ASSETS: Record<AssetId, { name: string; color: string }> = {
  BTC: { name: "Bitcoin", color: C.pink },
  ETH: { name: "Ethereum", color: C.purple },
};
const TIMEFRAMES: Timeframe[] = ["6M", "12M", "24M", "36M", "5Y", "ALL"];
const TF_MONTHS: Record<Timeframe, number> = { "6M": 6, "12M": 12, "24M": 24, "36M": 36, "5Y": 60, ALL: Infinity };
const TF_TEXT: Record<Timeframe, string> = { "6M": "6 months", "12M": "12 months", "24M": "24 months", "36M": "36 months", "5Y": "5 years", ALL: "full dataset" };
const PER_YEAR = 12; // observations per year: the only annualization factor used anywhere

/* --------------------------------- types --------------------------------- */
type AssetId = "BTC" | "ETH";
type Timeframe = "6M" | "12M" | "24M" | "36M" | "5Y" | "ALL";
type Num = number | null;
/** Component props are intentionally loose; the data model below is what the calculations rely on. */
type Props = Record<string, any>;
/** A raw record as read from a CSV, before validation. Every field is still text. */
interface RawRecord {
  date?: string; start?: string; end?: string; hiAt?: string; loAt?: string; quote?: string;
  open?: string | number; high?: string | number; low?: string | number; close?: string | number;
  volume?: string | number; marketCap?: string | number; supply?: string | number;
}
/** One calendar month of one asset, with the indicators attached by buildSeries. */
interface Row {
  date: string;            // "YYYY-MM"
  t: number;               // calendar index: year * 12 + month
  close: number; open: number; high: number; low: number; volume: number; marketCap: number; supply: number;
  period: "complete" | "partial" | "open" | "unknown";
  firstMark: string | null;
  ret?: Num; ret12?: Num; sma12?: Num; sma24?: Num; rsi?: Num; vol12?: Num; ddAth?: number;
  hl?: [number, number] | null; up?: boolean;
}
interface Quality {
  input: number; kept: number; dropped: number; dupes: number; missing: string[]; zeroVol: number;
  excludedLast: string | null; firstLate: string | null; complete: number; partial: string[]; unknown: number;
}
interface Series {
  asset: AssetId; rows: Row[]; hasOHLC: boolean; hasVolume: boolean; hasMcap: boolean; hasSupply: boolean;
  record: { close: number; date: string; under: number; longest: { months: number; from: string | null; to: string | null } } | null;
  quality: Quality;
  fileName?: string; provider?: string; providerBasis?: string; detected?: string[]; quote?: string; quoteOk?: boolean; bundled?: boolean;
}
/** A window of rows; `base` is the month-end just before it, when the dataset has one. */
type Win<T> = T[] & { base: T | null };
interface AlignedRow {
  date: string; t: number; close: number; bc: number; ec: number; br: Num; er: Num; bvol: Num; evol: Num; bmc: number; emc: number; corr12?: Num;
}
interface Dataset { loadedAt: string; source: string; btc: Series; eth: Series; bundled: boolean }

/* ====================== ANALYTICS (pure, monthly only) ====================== */
//#region analytics
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const mean = (a: number[]): Num => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
function stdev(a: number[]): Num {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function median(a: number[]): Num {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** RSI with Wilder smoothing. Null for the first n observations. */
function rsi(c: number[], n = 14): Num[] {
  const out = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  const val = () => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[n] = val();
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}

function pearson(x: number[], y: number[]): Num {
  if (x.length < 3 || x.length !== y.length) return null;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

const pad2 = (n) => String(n).padStart(2, "0");
function toDateKey(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{4}-\d{2}$/.test(s)) return s + "-01"; // a bare month, kept out of local-time parsing
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s), d = new Date(n < 1e11 ? n * 1000 : n);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  const s = String(v).replace(/[$,\s]/g, "");
  if (!s || s === "-" || /^(null|nan|n\/a)$/i.test(s)) return NaN;
  const m = /^(-?[\d.]+)([KMBT])$/i.exec(s);
  if (m) return Number(m[1]) * { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()];
  return Number(s);
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isYm = (v: unknown): boolean => /^\d{4}-\d{2}$/.test(String(v));
const ymLabel = (ym: string): string => (isYm(ym) ? `${MONTH_NAMES[+ym.slice(5) - 1]} ${ym.slice(0, 4)}` : String(ym));
const ymIndex = (ym: string): number => +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1);
const ymFromIndex = (i: number): string => `${Math.floor(i / 12)}-${pad2((i % 12) + 1)}`;
const monthBounds = (ym: string): [number, number] => [Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1), Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 1) - 1];

/** Peak-to-trough maximum drawdown on monthly closing prices. */
function maxDrawdown(rows: { close: number; date: string }[]): { mdd: number; peakDate: string; troughDate: string } | null {
  if (rows.length < 2) return null;
  let peak = rows[0].close, peakDate = rows[0].date, best = { mdd: 0, peakDate, troughDate: rows[0].date };
  for (const r of rows) {
    if (r.close > peak) { peak = r.close; peakDate = r.date; }
    const dd = r.close / peak - 1;
    if (dd < best.mdd) best = { mdd: dd, peakDate, troughDate: r.date };
  }
  return best;
}
/**
 * One row per calendar month. Cleans the observations, validates the calendar, and attaches
 * indicators computed on FULL history, so a short display window still shows a valid SMA 24.
 * No indicator ever bridges a missing month: the calendar index t (year * 12 + month) is checked.
 */
function buildSeries(asset: AssetId, raw: RawRecord[], now = Date.now()): Series {
  let dropped = 0, dupes = 0;
  const by = new Map<string, Row>();
  for (const r of raw) {
    const key = toDateKey(r.start) || toDateKey(r.date) || toDateKey(r.end), close = toNum(r.close);
    if (!key || !isNum(close) || close <= 0) { dropped++; continue; }
    const ym = key.slice(0, 7), [ms, me] = monthBounds(ym);
    if (by.has(ym)) dupes++;
    const s = r.start ? Date.parse(r.start) : NaN, e = r.end ? Date.parse(r.end) : NaN;
    // complete = the record's own start/end stamps span the whole calendar month (UTC)
    let period: Row["period"] = isNum(s) && isNum(e) ? (Math.abs(s - ms) < 1000 && Math.abs(e - me) < 60000 ? "complete" : "partial") : "unknown";
    if (me > now) period = "open";
    const marks = [r.hiAt, r.loAt].map((v) => (v ? Date.parse(v) : NaN)).filter(isNum);
    by.set(ym, {
      date: ym, t: ymIndex(ym), close, open: toNum(r.open), high: toNum(r.high), low: toNum(r.low),
      volume: toNum(r.volume), marketCap: toNum(r.marketCap), supply: toNum(r.supply), period,
      firstMark: marks.length === 2 ? new Date(Math.min(...marks)).toISOString().slice(0, 10) : null,
    });
  }
  const rows = [...by.values()].sort((a, b) => a.t - b.t);
  // A month still in progress (or cut short) at the end of the file is not a month-end close: keep it out.
  let excludedLast = null;
  if (rows.length && (rows[rows.length - 1].period === "open" || rows[rows.length - 1].period === "partial")) excludedLast = rows.pop().date;
  const missing = [];
  for (let i = 1; i < rows.length; i++) for (let t = rows[i - 1].t + 1; t < rows[i].t; t++) missing.push(ymFromIndex(t));
  const c = rows.map((r) => r.close), n = rows.length;
  const consecutive = (i, span) => i >= span && rows[i].t - rows[i - span].t === span;
  // RSI restarts after any missing month
  const rsiAll = new Array(n).fill(null);
  let from = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || rows[i].t - rows[i - 1].t !== 1) { rsi(c.slice(from, i), 14).forEach((v, k) => { rsiAll[from + k] = v; }); from = i; }
  }
  const byT = new Map(rows.map((r) => [r.t, r]));
  let peak = -Infinity, peakDate = null, under = 0, underFrom = null, longest = { months: 0, from: null, to: null };
  rows.forEach((r, i) => {
    r.ret = consecutive(i, 1) ? r.close / c[i - 1] - 1 : null; // simple monthly return
    const meanOf = (span) => (consecutive(i, span - 1) ? mean(c.slice(i - span + 1, i + 1)) : null);
    r.sma12 = meanOf(12); r.sma24 = meanOf(24); r.rsi = rsiAll[i];
    const y = byT.get(r.t - 12);
    r.ret12 = y ? r.close / y.close - 1 : null;
    if (r.close >= peak) {
      if (under > longest.months) longest = { months: under, from: underFrom, to: r.date };
      peak = r.close; peakDate = r.date; under = 0; underFrom = r.date;
    } else under++;
    r.ddAth = r.close / peak - 1;
    r.hl = isNum(r.low) && isNum(r.high) ? [r.low, r.high] : null;
    r.up = r.ret == null ? true : r.ret >= 0;
  });
  if (under > longest.months) longest = { months: under, from: underFrom, to: null };
  rows.forEach((r, i) => {
    const w = [];
    if (consecutive(i, 11)) for (let j = i - 11; j <= i; j++) if (isNum(rows[j].ret)) w.push(rows[j].ret);
    r.vol12 = w.length >= 10 ? stdev(w) * Math.sqrt(PER_YEAR) : null; // 12-month rolling, annualized
  });
  const hasOHLC = n > 0 && rows.every((r) => isNum(r.open) && isNum(r.high) && isNum(r.low) && r.high >= r.low);
  const zeroVol = rows.filter((r) => r.volume === 0).length;
  const hasVolume = rows.some((r) => isNum(r.volume) && r.volume > 0);
  const hasMcap = rows.filter((r) => isNum(r.marketCap) && r.marketCap > 0).length > n * 0.5;
  const first = rows[0];
  const firstLate = first && first.firstMark && +first.firstMark.slice(8, 10) >= 24 ? first.firstMark : null;
  return {
    asset, rows, hasOHLC, hasVolume, hasMcap, hasSupply: rows.some((r) => isNum(r.supply)),
    record: peakDate ? { close: peak, date: peakDate, under, longest } : null,
    quality: {
      input: raw.length, kept: n, dropped, dupes, missing, zeroVol, excludedLast, firstLate,
      complete: rows.filter((r) => r.period === "complete").length,
      partial: rows.filter((r) => r.period === "partial").map((r) => r.date),
      unknown: rows.filter((r) => r.period === "unknown").length,
    },
  };
}
/** Last N calendar months (or a start/end month range). `base` is the month-end before the window, when it exists. */
function windowRows<T extends { date: string; t: number } = any>(rows: T[], tf: Timeframe, range?: { start?: string; end?: string } | null): Win<T> {
  let w: any;
  if (!rows.length) w = [];
  else if (range && (range.start || range.end)) w = rows.filter((r) => (!range.start || r.date >= range.start) && (!range.end || r.date <= range.end));
  else {
    const n = TF_MONTHS[tf];
    w = Number.isFinite(n) ? rows.filter((r) => r.t > rows[rows.length - 1].t - n) : rows.slice();
  }
  w.base = null;
  if (w.length) { const i = rows.indexOf(w[0]); if (i > 0 && w[0].t - rows[i - 1].t === 1) w.base = rows[i - 1]; }
  return w;
}
const withBase = <T = any,>(w: Win<T>): T[] => (w.base ? [w.base, ...w] : w);
/**
 * Descriptive statistics for a window of monthly rows. `rf` is the ANNUAL risk-free rate as a decimal;
 * it is converted to a monthly rate by compounding.
 */
interface Stats {
  n: number; nRet: number; ret: Num; mVol: Num; annVol: Num; mdd: Num; cagr: Num; sharpe: Num; sortino: Num; calmar: Num;
  months?: number; start?: Row; last?: Row; dd?: { mdd: number; peakDate: string; troughDate: string } | null;
  meanRet?: Num; best?: Num; bestDate?: string | null; worst?: Num; worstDate?: string | null; posShare?: Num;
}
function windowStats(w: Win<Row>, rf = 0): Stats {
  const empty: Stats = { n: w.length, nRet: 0, ret: null, mVol: null, annVol: null, mdd: null, cagr: null, sharpe: null, sortino: null, calmar: null };
  if (!w.length) return empty;
  const start = w.base || w[0], last = w[w.length - 1];
  const rets = w.map((r) => r.ret).filter(isNum);
  const months = last.t - start.t;
  if (months < 1) return { ...empty, start, last, months };
  const sd = stdev(rets), mu = mean(rets);
  const ret = last.close / start.close - 1;
  const mVol = rets.length >= 6 && sd != null ? sd : null;
  const dd = maxDrawdown(withBase(w));
  const cagr = months >= 12 ? Math.pow(last.close / start.close, PER_YEAR / months) - 1 : null;
  const rfm = Math.pow(1 + rf, 1 / PER_YEAR) - 1;
  const enough = rets.length >= 12;
  const sharpe = enough && sd > 0 ? ((mu - rfm) / sd) * Math.sqrt(PER_YEAR) : null;
  const dsd = Math.sqrt(mean(rets.map((r) => Math.min(r - rfm, 0) ** 2)) || 0);
  const sortino = enough && dsd > 0 ? ((mu - rfm) / dsd) * Math.sqrt(PER_YEAR) : null;
  const calmar = cagr != null && dd && dd.mdd < 0 ? cagr / Math.abs(dd.mdd) : null;
  const dated = w.filter((r) => isNum(r.ret));
  const best = dated.reduce((a, r) => (!a || r.ret > a.ret ? r : a), null), worst = dated.reduce((a, r) => (!a || r.ret < a.ret ? r : a), null);
  return {
    n: w.length, nRet: rets.length, months, start, last, ret, mVol, annVol: mVol == null ? null : mVol * Math.sqrt(PER_YEAR),
    mdd: dd ? dd.mdd : null, dd, cagr, sharpe, sortino, calmar, meanRet: rets.length ? mu : null,
    best: best ? best.ret : null, bestDate: best ? best.date : null, worst: worst ? worst.ret : null, worstDate: worst ? worst.date : null,
    posShare: rets.length ? rets.filter((r) => r > 0).length / rets.length : null,
  };
}
/** Return over exactly `months` calendar months ending at the last observation; null if that month is absent. */
function trailingReturn(rows: Row[], months: number): Num {
  if (!rows.length) return null;
  const last = rows[rows.length - 1], base = rows.find((r) => r.t === last.t - months);
  return base ? last.close / base.close - 1 : null;
}
/** Donchian extremes: highest high / lowest low of the last n consecutive months (closes if no high/low). */
function donchian(rows: Row[], n: number): { n: number; resistance: number; support: number } | null {
  if (rows.length < n) return null;
  const w = rows.slice(-n);
  if (w[n - 1].t - w[0].t !== n - 1) return null;
  return { n, resistance: Math.max(...w.map((r) => (isNum(r.high) ? r.high : r.close))), support: Math.min(...w.map((r) => (isNum(r.low) ? r.low : r.close))) };
}
/** Inner-join on calendar month, then add the 12-month rolling correlation of monthly returns. */
function alignSeries(a: Row[], b: Row[]): AlignedRow[] {
  const m = new Map<string, Row>(b.map((r) => [r.date, r]));
  const out: AlignedRow[] = [];
  for (const r of a) {
    const o = m.get(r.date);
    if (o) out.push({ date: r.date, t: r.t, close: r.close, bc: r.close, ec: o.close, br: r.ret, er: o.ret, bvol: r.vol12, evol: o.vol12, bmc: r.marketCap, emc: o.marketCap });
  }
  out.forEach((r, i) => {
    r.corr12 = null;
    if (i < 11 || r.t - out[i - 11].t !== 11) return;
    const x = [], y = [];
    for (let j = i - 11; j <= i; j++) if (isNum(out[j].br) && isNum(out[j].er)) { x.push(out[j].br); y.push(out[j].er); }
    if (x.length >= 10) r.corr12 = pearson(x, y);
  });
  return out;
}
function windowCorr(al: AlignedRow[]): { r: Num; n: number } | null {
  const x: number[] = [], y: number[] = [];
  al.forEach((r) => { if (isNum(r.br) && isNum(r.er)) { x.push(r.br); y.push(r.er); } });
  return x.length >= 6 ? { r: pearson(x, y), n: x.length } : null;
}
/** Calendar-year returns from December closes. Years without both Decembers are labelled, not estimated. */
function calendarYears(rows: Row[]): { year: string; ret: number; full: boolean; months: number; note: string }[] {
  const byT = new Map(rows.map((r) => [r.t, r])), out = [];
  if (!rows.length) return out;
  for (let y = +rows[0].date.slice(0, 4); y <= +rows[rows.length - 1].date.slice(0, 4); y++) {
    const inYear = rows.filter((r) => +r.date.slice(0, 4) === y);
    if (!inYear.length) continue;
    const prevDec = byT.get(y * 12 - 1), end = inYear[inYear.length - 1], first = inYear[0];
    const full = !!prevDec && end.t === y * 12 + 11 && inYear.length === 12;
    const base = prevDec || first;
    if (base === end) continue;
    out.push({
      year: String(y), ret: end.close / base.close - 1, full, months: end.t - base.t,
      note: full ? "Full year" : `${ymLabel(base.date)} close to ${ymLabel(end.date)} close${inYear.length < end.t - first.t + 1 ? ", months missing" : ""}`,
    });
  }
  return out;
}
/** Minimal RFC 4180 reader: quoted fields, escaped quotes, CRLF, and comma, semicolon or tab delimiters. */
function readCsv(text: string): { rows: string[][]; delim: string } {
  const src = String(text).replace(/^\uFEFF/, "");
  const head = src.split(/\r?\n/, 1)[0] || "";
  const delim = [",", ";", "\t"].map((d): [string, number] => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", q = false;
  const endRow = () => { row.push(cell); cell = ""; if (row.some((c) => c.trim() !== "")) rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && src[i + 1] === "\n") i++; endRow(); }
    else cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return { rows, delim };
}
function writeCsv(objs: Record<string, unknown>[]): string {
  if (!objs.length) return "";
  const keys = Object.keys(objs[0]);
  const esc = (v) => { const t = v == null ? "" : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return [keys.map(esc).join(","), ...objs.map((o) => keys.map((k) => esc(o[k])).join(","))].join("\r\n") + "\r\n";
}

const HEADER_ALIASES: Record<string, string[]> = {
  start: ["timeopen", "period_start", "open_time", "start"],
  end: ["timeclose", "period_end", "close_time", "end"],
  date: ["date", "timestamp", "time", "datetime", "snapped_at", "month", "period", "unix", "datum"],
  hiAt: ["timehigh"], loAt: ["timelow"], quote: ["name"],
  open: ["open", "open_price"], high: ["high", "high_price"], low: ["low", "low_price"],
  close: ["close", "price", "adj close", "adj_close", "close_price", "closing price", "last"],
  volume: ["volume", "total_volume", "volume usd", "volume_usd", "volume (usd)", "vol", "vol."],
  marketCap: ["marketcap", "market_cap", "market cap", "mcap"],
  supply: ["circulatingsupply", "circulating_supply", "circulating supply"],
};
const FIELD_LABELS: Record<string, string> = { start: "period start", end: "period end", date: "date", hiAt: "time of high", loAt: "time of low", quote: "quote currency id", open: "open", high: "high", low: "low", close: "close", volume: "volume", marketCap: "market cap", supply: "circulating supply" };
/** Maps a CSV onto the monthly schema. Throws a readable message when the file cannot be used as monthly data. */
function parseCsv(asset: AssetId, text: string, fileName = "", now = Date.now()): Series {
  const { rows, delim } = readCsv(text);
  if (rows.length < 2) throw new Error(`The ${asset} file is empty or has no data rows.`);
  const fields = rows[0].map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const k of Object.keys(HEADER_ALIASES)) {
    idx[k] = -1;
    for (const a of HEADER_ALIASES[k]) { const i = fields.indexOf(a); if (i >= 0) { idx[k] = i; break; } }
  }
  const dateCol = idx.start >= 0 ? idx.start : idx.date >= 0 ? idx.date : idx.end;
  if (dateCol < 0 || idx.close < 0) {
    throw new Error(`The ${asset} file needs a date (or period start) column and a close column. Columns found: ${fields.filter(Boolean).join(", ") || "none"}.`);
  }
  const body = rows.slice(1);
  // Day-first or month-first is decided once from the whole column, never guessed row by row.
  const parts = body.map((r) => /^(\d{1,2})([\/.-])(\d{1,2})\2(\d{4})/.exec(String(r[dateCol] || "").trim()));
  const found = parts.filter(Boolean);
  let dayFirst = false;
  if (found.length) {
    const aMax = Math.max(...found.map((m) => +m[1])), bMax = Math.max(...found.map((m) => +m[3]));
    if (aMax > 12 && bMax <= 12) dayFirst = true;
    else if (!(bMax > 12 && aMax <= 12)) throw new Error(`The ${asset} file has dates that could be day-first or month-first. Re-export with YYYY-MM-DD dates.`);
  }
  const fix = (v) => (delim === ";" && typeof v === "string" && v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v);
  const textual = { start: 1, end: 1, date: 1, hiAt: 1, loAt: 1, quote: 1 };
  const raw = body.map((r, i) => {
    const o: Record<string, any> = {};
    for (const k of Object.keys(idx)) o[k] = idx[k] >= 0 ? (textual[k] ? r[idx[k]] : fix(r[idx[k]])) : undefined;
    const m = parts[i];
    if (m) { const iso = `${m[4]}-${pad2(dayFirst ? m[3] : m[1])}-${pad2(dayFirst ? m[1] : m[3])}`; if (dateCol === idx.start) o.start = iso; else o.date = iso; }
    return o;
  });
  // Frequency check: this dashboard only accepts one observation per calendar month.
  const months = raw.map((o) => toDateKey(o.start) || toDateKey(o.date) || toDateKey(o.end)).filter(Boolean).map((k) => k.slice(0, 7));
  const distinct = [...new Set(months)].sort();
  if (months.length >= 6 && months.length / distinct.length > 1.5) {
    const per = months.length / distinct.length;
    throw new Error(`The ${asset} file has about ${per.toFixed(0)} rows per calendar month, so it is ${per > 15 ? "daily" : "weekly"} data. This dashboard analyses monthly data only: export the file with the Monthly setting.`);
  }
  if (distinct.length >= 4) {
    const step = median(distinct.slice(1).map((ym, i) => ymIndex(ym) - ymIndex(distinct[i])));
    if (step >= 2.5) throw new Error(`The ${asset} file has rows about ${step.toFixed(0)} months apart. This dashboard needs one row per calendar month.`);
  }
  const s = buildSeries(asset, raw, now);
  if (s.rows.length < 2) throw new Error(`The ${asset} file has fewer than 2 usable monthly rows. Check that the date and close columns contain values.`);
  const cmcShape = ["timeopen", "timeclose", "close", "marketcap"].every((f) => fields.includes(f));
  s.fileName = fileName;
  s.provider = cmcShape || /coinmarketcap/i.test(fileName) ? "CoinMarketCap" : "User-supplied file";
  s.providerBasis = cmcShape ? "column layout of a CoinMarketCap export" : /coinmarketcap/i.test(fileName) ? "file name" : "provider not identifiable from the file";
  s.detected = Object.keys(idx).filter((k) => idx[k] >= 0).map((k) => `${FIELD_LABELS[k]} ("${rows[0][idx[k]].trim()}")`);
  const quotes = idx.quote >= 0 ? [...new Set(body.map((r) => String(r[idx.quote] || "").trim()).filter(Boolean))] : [];
  // CoinMarketCap writes its currency id in the "name" column; 2781 is USD.
  s.quote = !quotes.length ? "not stated in file, assumed USD" : quotes.length === 1 && quotes[0] === "2781" ? "USD (CoinMarketCap id 2781)" : `id ${quotes.join(", ")}: not confirmed as USD`;
  s.quoteOk = !quotes.length || (quotes.length === 1 && quotes[0] === "2781");
  return s;
}
//#endregion analytics

/* =============================== formatting =============================== */
const DASH = "—";
function fmtUSD(v, compact = false) {
  if (!isNum(v)) return DASH;
  if (compact || Math.abs(v) >= 1e6) {
    const a = Math.abs(v);
    const [d, u] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
    return "$" + (v / d).toFixed(u ? 2 : 0) + u;
  }
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: v < 10 ? 4 : 2, maximumFractionDigits: v < 10 ? 4 : 2 });
}
const fmtPct = (v, dp = 2, sign = true) => (isNum(v) ? (sign && v > 0 ? "+" : "") + (Math.abs(v * 100) >= 1000 ? Math.round(v * 100).toLocaleString("en-US") : (v * 100).toFixed(dp)) + "%" : DASH);
const fmtNum = (v, dp = 2) => (isNum(v) ? v.toFixed(dp) : DASH);
const moveColor = (v) => (!isNum(v) || v === 0 ? C.muted : v > 0 ? C.up : C.down);

/* ============================== data loading ============================== */
function makeData(btc: Series, eth: Series): Dataset | null {
  const used = [btc, eth].filter((s) => s.rows.length);
  if (!used.length) return null;
  const providers = [...new Set(used.map((s) => s.provider))];
  return { loadedAt: new Date().toISOString(), source: `${providers.join(" and ")}, monthly historical data`, btc, eth, bundled: used.every((s) => s.bundled) };
}
const emptySeries = (a: AssetId): Series => buildSeries(a, []);
function loadBundled(): Dataset | null {
  const one = (a: AssetId) => { const s = parseCsv(a, BUNDLED[a].csv, BUNDLED[a].fileName); s.bundled = true; return s; };
  return makeData(one("BTC"), one("ETH"));
}
const coverage = (rows: { date: string }[]): string => (rows.length ? `${ymLabel(rows[0].date)} to ${ymLabel(rows[rows.length - 1].date)}` : "no observations");
function tableCsv(cols, rows) {
  return writeCsv(rows.map((r) => Object.fromEntries(cols.map((c) => [c.csv || c.label, c.raw ? c.raw(r) : r[c.key]]))));
}
/** Rasterizes the chart SVG onto a canvas with title, legend and source line. Returns a PNG data URL. */
async function renderPng(node, title, footer, legend = []) {
  const svg = node && node.querySelector("svg.recharts-surface");
  if (!svg) throw new Error("no chart is drawn yet");
  const { width, height } = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", width); clone.setAttribute("height", height);
  clone.setAttribute("font-family", "Arial, sans-serif");
  const img = new Image();
  await new Promise((ok, bad) => {
    img.onload = ok; img.onerror = () => bad(new Error("the browser could not rasterize the chart"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  });
  const k = 2, pad = 24, head = legend.length ? 70 : 52, foot = 38;
  const cv = document.createElement("canvas");
  cv.width = Math.round((width + pad * 2) * k); cv.height = Math.round((height + head + foot) * k);
  const ctx = cv.getContext("2d");
  ctx.scale(k, k);
  ctx.fillStyle = C.surface; ctx.fillRect(0, 0, width + pad * 2, height + head + foot);
  ctx.fillStyle = C.text; ctx.font = "600 15px Arial, sans-serif"; ctx.fillText(title, pad, 32);
  ctx.font = "11px Arial, sans-serif";
  let lx = pad;
  legend.forEach((l) => {
    ctx.fillStyle = l.color; ctx.fillRect(lx, 50, 14, 2);
    ctx.fillStyle = C.muted; ctx.fillText(l.label, lx + 20, 55);
    lx += 20 + ctx.measureText(l.label).width + 18;
  });
  ctx.drawImage(img, pad, head, width, height);
  ctx.fillStyle = C.muted; ctx.fillText(footer, pad, head + height + 24);
  return cv.toDataURL("image/png");
}
const slug = (t) => t.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

/* ================================ UI atoms ================================ */
interface ExportJob { kind: "png" | "csv"; name: string; url?: string; text?: string }
interface AppCtx {
  data: Dataset; error: string;
  tf: Timeframe; setTf: (tf: Timeframe) => void;
  rf: number; rfText: string; setRfText: (v: string) => void;
  go: (section: string) => void; toast: (text: string, bad?: boolean) => void;
  applyCsv: (asset: AssetId, series: Series | null) => void; restore: () => void;
  exp: ExportJob | null; openExport: (job: ExportJob) => void; closeExport: () => void;
}
const Ctx = React.createContext<AppCtx | null>(null);
const useApp = (): AppCtx => React.useContext(Ctx) as AppCtx;

function Card({ children, className = "", style }: Props) {
  return <div className={`rounded-lg min-w-0 ${className}`} style={{ background: C.surface, border: `1px solid ${C.border}`, ...style }}>{children}</div>;
}
function Btn({ children, onClick, primary, disabled, title }: Props) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled}
      className="ps-btn inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium"
      style={{ background: primary ? C.pink : C.raised, color: primary ? "#fff" : C.text, border: `1px solid ${primary ? C.pink : C.border}`, opacity: disabled ? 0.45 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>
      {children}
    </button>
  );
}
function Seg({ options, value, onChange, label }: Props) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value, l = typeof o === "string" ? o : o.label, dis = typeof o !== "string" && o.disabled;
        const on = v === value;
        return (
          <button key={v} type="button" disabled={dis} aria-pressed={on} onClick={() => onChange(v)} title={dis ? o.hint : undefined}
            className="ps-seg px-3 py-1 text-xs font-medium"
            style={{ background: on ? C.pink : "transparent", color: on ? "#fff" : dis ? C.faint : C.muted, cursor: dis ? "not-allowed" : "pointer" }}>
            {l}
          </button>
        );
      })}
    </div>
  );
}

function Tag({ children }: Props) {
  return <span className="rounded shrink-0" style={{ fontSize: 10, lineHeight: "14px", padding: "1px 6px", letterSpacing: "0.03em", color: C.slate, border: `1px solid ${C.border}`, background: C.raised }}>{children}</span>;
}
/** One panel of figures separated by hairlines (the 1px grid gap shows the border color). */
function KpiRow({ cols = 4, children }: Props) {
  const lg = { 4: "lg:grid-cols-4", 5: "lg:grid-cols-5", 6: "lg:grid-cols-6" }[cols];
  return <div className={`grid grid-cols-2 ${lg} rounded-lg overflow-hidden`} style={{ background: C.border, border: `1px solid ${C.border}`, gap: 1 }}>{children}</div>;
}

function Kpi({ label, value, sub, tone, note, small }: Props) {
  const has = value !== DASH;
  return (
    <div className="p-4 min-w-0" style={{ background: C.surface }}>
      <div className="text-xs" style={{ color: C.muted, lineHeight: 1.35 }}>{label}</div>
      <div className={`mt-2 ${small ? "text-xl" : "text-2xl"} font-semibold`} style={{ color: has && tone ? tone : has ? C.text : C.faint, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.015em", lineHeight: 1.2 }}>{value}</div>
      {sub != null && <div className="mt-1 text-xs" style={{ color: C.muted, fontVariantNumeric: "tabular-nums", lineHeight: 1.4 }}>{sub}</div>}
      {note && <div className="mt-1 text-xs" style={{ color: C.faint, lineHeight: 1.4 }}>{note}</div>}
    </div>
  );
}
/** The provenance strip: source, frequency, analysis period, dataset coverage. Shown on every section. */
function Provenance({ rows, full }: Props) {
  const { data } = useApp();
  if (!data) return null;
  const item = (k, v) => (
    <div className="flex gap-2"><span style={{ color: C.faint }}>{k}</span><span style={{ color: C.slate, fontVariantNumeric: "tabular-nums" }}>{v}</span></div>
  );
  return (
    <div data-strip="provenance" className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 rounded-lg text-xs" style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `2px solid ${C.pink}` }}>
      {item("Source", data.source)}
      {item("Frequency", "Monthly")}
      {item("Analysis period", rows && rows.length ? `${coverage(rows)} (${rows.length} monthly obs.)` : "no observations")}
      {full && full.length ? item("Dataset coverage", `${coverage(full)} (${full.length} months)`) : null}
      {item("Loaded", data.loadedAt.replace("T", " ").slice(0, 16) + " UTC")}
    </div>
  );
}
function ChartCard({ title, subtitle, children, height = 300, actions, legend, empty }: Props) {
  const ref = useRef(null);
  const { data, toast, openExport } = useApp();
  const onPng = async () => {
    try {
      const footer = `Monthly data. Source: ${data.source}. Research & Data Visualization by PinkShazam`;
      openExport({ kind: "png", name: slug(title) + "-monthly.png", url: await renderPng(ref.current, `${title} (monthly data)`, footer, legend || []) });
    } catch (e) { toast("PNG export failed: " + e.message, true); }
  };
  return (
    <Card className="p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold" style={{ color: C.text }}>{title}</h3>
            <Tag>Monthly</Tag>
          </div>
          {subtitle && <p className="text-xs mt-1" style={{ color: C.muted, maxWidth: 640, lineHeight: 1.5 }}>{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {!empty && (
            <button type="button" onClick={onPng} title="Export chart as PNG" aria-label={`Export ${title} as PNG`} className="ps-icon inline-flex items-center gap-1 px-2 py-1 rounded text-xs" style={{ color: C.muted, border: `1px solid ${C.border}` }}>
              <Camera size={13} />PNG
            </button>
          )}
        </div>
      </div>
      {empty ? <Empty text={empty} height={height} /> : (
        <>
          <div ref={ref} style={{ width: "100%", height }}>{children}</div>
          {legend && <div className="mt-3"><Legend items={legend} /></div>}
        </>
      )}
    </Card>
  );
}
function ExportDialog() {
  const { exp, closeExport, toast } = useApp();
  const area = useRef(null);
  useEffect(() => {
    if (!exp) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeExport(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exp, closeExport]);
  if (!exp) return null;
  const href = exp.kind === "png" ? exp.url : "data:text/csv;charset=utf-8," + encodeURIComponent(exp.text);
  const copy = async () => {
    try { await navigator.clipboard.writeText(exp.text); toast("CSV copied"); }
    catch (e) { if (area.current) { area.current.focus(); area.current.select(); } toast("Copy is blocked here. The text is selected: press Ctrl or Cmd + C.", true); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(5,6,10,0.78)" }} onClick={closeExport}>
      <div role="dialog" aria-modal="true" aria-label={`Export ${exp.name}`} className="w-full rounded-lg p-5" style={{ maxWidth: 760, maxHeight: "90vh", overflowY: "auto", background: C.surface, border: `1px solid ${C.border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold" style={{ color: C.text }}>{exp.kind === "png" ? "Chart image" : "Table data"}</h3>
            <p className="text-xs mt-1" style={{ color: C.muted }}>{exp.name}</p>
          </div>
          <button type="button" aria-label="Close" onClick={closeExport} className="ps-icon p-1" style={{ color: C.muted }}><X size={16} /></button>
        </div>
        <div className="mt-4">
          {exp.kind === "png"
            ? <img src={exp.url} alt={exp.name} style={{ width: "100%", borderRadius: 6, border: `1px solid ${C.border}` }} />
            : <textarea ref={area} readOnly value={exp.text} rows={10} onFocus={(e) => e.target.select()} className="w-full rounded-md p-3 text-xs" style={{ background: C.bg, color: C.slate, border: `1px solid ${C.border}`, fontFamily: "ui-monospace, Menlo, Consolas, monospace", resize: "vertical" }} />}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <a href={href} download={exp.name} className="ps-btn inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium" style={{ background: C.pink, color: "#fff", border: `1px solid ${C.pink}`, textDecoration: "none" }}><Download size={14} />Download file</a>
          {exp.kind === "csv" && <Btn onClick={copy}>Copy CSV</Btn>}
        </div>
        <p className="mt-3 text-xs" style={{ color: C.faint }}>
          {exp.kind === "png" ? "If the download does not start (some embedded previews block it), right-click or long-press the image and save it." : "If the download does not start (some embedded previews block it), copy the text and paste it into a .csv file."}
        </p>
      </div>
    </div>
  );
}

function Empty({ text, height = 160 }: Props) {
  return (
    <div className="flex items-center justify-center text-center text-xs px-6 rounded-md" style={{ height, color: C.muted, border: `1px dashed ${C.border}` }}>
      <div style={{ maxWidth: 420 }}>{text}</div>
    </div>
  );
}
function Legend({ items }: Props) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: C.muted }}>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-2">
          <span style={{ width: 14, height: 0, borderTop: `2px ${i.dash ? "dashed" : "solid"} ${i.color}`, display: "inline-block" }} />{i.label}
        </span>
      ))}
    </div>
  );
}

function Tip({ active, payload, label, fmt = {} }: Props) {
  if (!active || !payload || !payload.length) return null;
  const p0 = payload[0].payload || {};
  const lines = payload.filter((p) => p.dataKey !== "hl" && isNum(p.value));
  return (
    <div className="rounded-md px-3 py-2 text-xs" style={{ background: "#0F121A", border: `1px solid ${C.border}`, color: C.text, fontVariantNumeric: "tabular-nums", boxShadow: "0 8px 24px rgba(0,0,0,0.45)" }}>
      <div className="mb-1" style={{ color: C.muted }}>{ymLabel(label)}{p0.period === "partial" ? " (partial month)" : ""}</div>
      {fmt.ohlc && isNum(p0.open) && (
        <div className="mb-1" style={{ color: C.slate }}>
          O {fmtUSD(p0.open)} &nbsp;H {fmtUSD(p0.high)} &nbsp;L {fmtUSD(p0.low)} &nbsp;C {fmtUSD(p0.close)}
        </div>
      )}
      {lines.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-6">
          <span className="inline-flex items-center gap-2"><span style={{ width: 8, height: 8, borderRadius: 2, background: p.color || p.stroke || C.muted, display: "inline-block" }} />{p.name}</span>
          <span className="font-semibold">{(fmt[p.dataKey] || fmt.default || fmtNum)(p.value)}</span>
        </div>
      ))}
    </div>
  );
}
const axis = { tick: { fontSize: 11, fill: C.muted }, stroke: C.border, tickLine: false, tickMargin: 6 };
// Month axis: "Jan 24" for short spans, the year alone for long ones.
const xTick = (rows) => (d) => (!isYm(d) ? String(d) : rows.length > 40 ? String(d).slice(0, 4) : `${MONTH_NAMES[+String(d).slice(5) - 1]} ${String(d).slice(2, 4)}`);
const xGap = (rows) => (rows.length > 40 ? 56 : 36);
const grid = <CartesianGrid stroke={C.border} strokeDasharray="2 4" vertical={false} />;
const noAnim = { isAnimationActive: false, dot: false };
const tipProps = { wrapperStyle: { outline: "none", zIndex: 20 }, cursor: { stroke: C.faint, strokeDasharray: "3 3" } };
const barTip = { wrapperStyle: { outline: "none", zIndex: 20 }, cursor: { fill: "rgba(255,255,255,0.04)" } };

function Table({ cols, rows, csvName, caption, note }: Props) {
  const { openExport } = useApp();
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 md:px-5 pt-4 pb-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: C.text }}>{caption}</h3>
          {note && <p className="text-xs mt-1" style={{ color: C.muted, maxWidth: 620, lineHeight: 1.5 }}>{note}</p>}
        </div>
        {csvName && rows.length > 0 && (
          <Btn onClick={() => openExport({ kind: "csv", name: csvName, text: tableCsv(cols, rows) })}><Download size={14} />Export CSV</Btn>
        )}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="w-full text-sm" style={{ fontVariantNumeric: "tabular-nums", borderCollapse: "collapse" }}>
          <thead>
            <tr>{cols.map((c) => (
              <th key={c.label} scope="col" className={`px-4 py-2 text-xs font-medium whitespace-nowrap ${c.left ? "text-left" : "text-right"}`} style={{ color: C.muted, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>{c.label}</th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="ps-row">
                {cols.map((c) => (
                  <td key={c.label} className={`px-4 py-2 whitespace-nowrap ${c.left ? "text-left" : "text-right"}`} style={{ color: c.color ? c.color(r) : C.text, borderBottom: `1px solid ${C.border}` }}>
                    {c.render ? c.render(r) : r[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
function NeedData({ what }: Props) {
  const { error, restore, go } = useApp();
  return (
    <Card className="p-8">
      <div className="mx-auto text-center" style={{ maxWidth: 520 }}>
        <AlertTriangle size={22} className="mx-auto" style={{ color: C.amber }} />
        <p className="mt-3 text-sm font-semibold" style={{ color: C.text }}>{what || "No monthly data loaded"}</p>
        <p className="mt-2 text-xs" style={{ color: C.muted }}>{error || "Upload a monthly CSV for this asset. Nothing is shown in place of missing data."}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Btn primary onClick={() => go("data")}><Upload size={14} />Upload monthly CSV</Btn>
          <Btn onClick={restore}><RotateCcw size={14} />Restore bundled CoinMarketCap files</Btn>
        </div>
      </div>
    </Card>
  );
}
const pctRaw = (v) => (isNum(v) ? +(v * 100).toFixed(4) : "");

/* ============================= Market Overview ============================= */
function Sparkline({ rows, color }: Props) {
  return (
    <div style={{ width: "100%", height: 44 }}>
      <ResponsiveContainer>
        <AreaChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Area type="monotone" dataKey="close" stroke={color} strokeWidth={1.5} fill={color} fillOpacity={0.12} {...noAnim} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
function AssetCard({ series, tf }: Props) {
  const a = ASSETS[series.asset], w = windowRows(series.rows, tf), st = windowStats(w);
  const last = series.rows[series.rows.length - 1];
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <span style={{ width: 8, height: 8, borderRadius: 8, background: a.color, display: "inline-block" }} />
        <span className="text-sm font-semibold" style={{ color: C.text }}>{a.name}</span>
        <span className="text-xs" style={{ color: C.muted }}>{series.asset}/USD, {ymLabel(last.date)} close</span>
      </div>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold" style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{fmtUSD(last.close)}</div>
          <div className="text-xs mt-1" style={{ fontVariantNumeric: "tabular-nums" }}>
            <span style={{ color: moveColor(last.ret) }}>{fmtPct(last.ret)}</span><span style={{ color: C.faint }}> 1M</span>
            <span className="ml-3" style={{ color: moveColor(st.ret) }}>{fmtPct(st.ret)}</span><span style={{ color: C.faint }}> {tf}</span>
          </div>
        </div>
        <div style={{ width: 150 }}><Sparkline rows={withBase(w)} color={a.color} /></div>
      </div>
    </Card>
  );
}
function Overview() {
  const { data, tf } = useApp();
  const { btc, eth } = data;
  const base = btc.rows.length ? btc : eth;
  const w = windowRows(base.rows, tf);
  const both = btc.rows.length > 1 && eth.rows.length > 1;
  const al = useMemo(() => alignSeries(btc.rows, eth.rows), [btc, eth]);
  const alw = useMemo(() => windowRows(al, tf), [al, tf]);
  const pair = useMemo(() => {
    if (alw.length < 1) return null;
    const a0 = alw.base || alw[0], a1 = alw[alw.length - 1];
    return { ratio: a1.ec / a1.bc, chg: a1.ec / a1.bc / (a0.ec / a0.bc) - 1, corr: windowCorr(alw), share: isNum(a1.bmc) && isNum(a1.emc) ? a1.bmc / (a1.bmc + a1.emc) : null };
  }, [alw]);
  const mcap = useMemo(() => (btc.hasMcap && eth.hasMcap ? alw.filter((r) => isNum(r.bmc) && isNum(r.emc)).map((r) => ({ date: r.date, btc: r.bmc, eth: r.emc })) : []), [btc, eth, alw]);
  const perf = useMemo(() => {
    if (both) { const p = withBase(alw); return p.map((r) => ({ date: r.date, btc: r.bc / p[0].bc - 1, eth: r.ec / p[0].ec - 1 })); }
    const k = btc.rows.length > 1 ? "btc" : "eth", p = withBase(w);
    return p.map((r) => ({ date: r.date, [k]: r.close / p[0].close - 1 }));
  }, [both, alw, w, btc]);
  const loaded = [btc, eth].filter((s) => s.rows.length > 1);
  const rowsT = loaded.map((s) => {
    const l = s.rows[s.rows.length - 1];
    return { name: ASSETS[s.asset].name, symbol: s.asset, month: ymLabel(l.date), price: l.close, m1: l.ret, m12: trailingReturn(s.rows, 12), m36: trailingReturn(s.rows, 36), m60: trailingReturn(s.rows, 60), mcap: l.marketCap, volume: l.volume, supply: l.supply };
  });
  const pc = (k, label) => ({ label, csv: `${label} return (%)`, render: (r) => fmtPct(r[k], 1), color: (r) => moveColor(r[k]), raw: (r) => pctRaw(r[k]) });
  const lastOf = (s) => s.rows[s.rows.length - 1];
  const recKpi = (s) => {
    if (s.rows.length < 2) return <Kpi key={`rec-${s.asset}`} label={`${s.asset} versus record monthly close`} value={DASH} sub="Not loaded" />;
    const l = lastOf(s);
    return <Kpi key={`rec-${s.asset}`} label={`${s.asset} versus record monthly close`} value={l.ddAth === 0 ? "At record" : fmtPct(l.ddAth, 1)} tone={l.ddAth === 0 ? undefined : moveColor(l.ddAth)} sub={`Record ${fmtUSD(s.record.close)}, ${ymLabel(s.record.date)}`} />;
  };
  const r12Kpi = (s) => {
    const v = s.rows.length > 1 ? trailingReturn(s.rows, 12) : null;
    return <Kpi key={`r12-${s.asset}`} label={`${s.asset} 12-month return`} value={fmtPct(v, 1)} tone={moveColor(v)} sub={s.rows.length > 1 ? (isNum(v) ? `to ${ymLabel(lastOf(s).date)} close` : "Needs 13 consecutive months") : "Not loaded"} />;
  };
  return (
    <div className="space-y-4">
      <Provenance rows={w} full={base.rows} />
      <KpiRow cols={4}>
        {r12Kpi(btc)}
        {r12Kpi(eth)}
        {recKpi(btc)}
        {recKpi(eth)}
      </KpiRow>
      <KpiRow cols={4}>
        <Kpi label="ETH/BTC ratio, month-end" value={pair ? pair.ratio.toFixed(5) : DASH} sub={pair ? <span><span style={{ color: moveColor(pair.chg) }}>{fmtPct(pair.chg, 1)}</span> over {tf}</span> : "Needs both assets"} />
        <Kpi label={`BTC / ETH correlation, ${tf}`} value={pair && pair.corr ? fmtNum(pair.corr.r) : DASH} sub={pair && pair.corr ? `${pair.corr.n} monthly returns` : "Needs 6 shared monthly returns"} />
        <Kpi label="BTC share of BTC + ETH market cap" value={pair ? fmtPct(pair.share, 1, false) : DASH} sub={pair && isNum(pair.share) ? "Two assets only, not market dominance" : "Needs market cap for both"} />
        <Kpi label="Months of shared history" value={both ? String(al.length) : DASH} sub={both ? coverage(al) : "Needs both assets"} />
      </KpiRow>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {btc.rows.length > 1 && <AssetCard series={btc} tf={tf} />}
        {eth.rows.length > 1 && <AssetCard series={eth} tf={tf} />}
      </div>
      <ChartCard title="BTC and ETH price performance" height={300}
        subtitle={`Month-end closes, rebased to 0% at the ${perf.length ? ymLabel(perf[0].date) : ""} close.`}
        legend={[btc.rows.length > 1 && { label: "BTC", color: C.pink }, eth.rows.length > 1 && { label: "ETH", color: C.purple }].filter(Boolean)}
        empty={perf.length < 2 ? "The selected window holds fewer than two monthly observations." : null}>
        <ResponsiveContainer>
          <LineChart data={perf} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            {grid}
            <XAxis dataKey="date" {...axis} tickFormatter={xTick(perf)} minTickGap={xGap(perf)} />
            <YAxis {...axis} width={56} tickFormatter={(v) => fmtPct(v, 0)} />
            <Tooltip {...tipProps} content={<Tip fmt={{ default: (v) => fmtPct(v, 1) }} />} />
            <ReferenceLine y={0} stroke={C.faint} />
            <Line name="BTC" type="monotone" dataKey="btc" stroke={C.pink} strokeWidth={1.6} {...noAnim} />
            <Line name="ETH" type="monotone" dataKey="eth" stroke={C.purple} strokeWidth={1.6} {...noAnim} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="BTC and ETH market capitalization" height={280}
        subtitle="Month-end values as reported by the source, stacked. These two assets only: the files hold no total-market figure."
        legend={[{ label: "BTC", color: C.pink }, { label: "ETH", color: C.purple }]}
        empty={mcap.length < 2 ? "Market capitalization history needs a market cap column in both files." : null}>
        <ResponsiveContainer>
          <AreaChart data={mcap} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            {grid}
            <XAxis dataKey="date" {...axis} tickFormatter={xTick(mcap)} minTickGap={xGap(mcap)} />
            <YAxis {...axis} width={64} tickFormatter={(v) => fmtUSD(v, true)} />
            <Tooltip {...tipProps} content={<Tip fmt={{ default: (v) => fmtUSD(v, true) }} />} />
            <Area name="BTC" stackId="1" type="monotone" dataKey="btc" stroke={C.pink} fill={C.pink} fillOpacity={0.22} strokeWidth={1.5} {...noAnim} />
            <Area name="ETH" stackId="1" type="monotone" dataKey="eth" stroke={C.purple} fill={C.purple} fillOpacity={0.22} strokeWidth={1.5} {...noAnim} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
      <Table caption="Asset performance at the latest month-end" csvName="pinkshazam-asset-performance-monthly.csv" rows={rowsT}
        note="Returns are close to close over whole calendar months. A dash means the dataset does not reach back that far."
        cols={[
          { label: "Asset", left: true, render: (r) => <span>{r.name} <span style={{ color: C.muted }}>{r.symbol}</span></span>, raw: (r) => r.symbol },
          { label: "Month", key: "month", left: true },
          { label: "Close (USD)", render: (r) => fmtUSD(r.price), raw: (r) => r.price },
          pc("m1", "1M"), pc("m12", "12M"), pc("m36", "36M"), pc("m60", "5Y"),
          { label: "Market cap", render: (r) => fmtUSD(r.mcap, true), raw: (r) => (isNum(r.mcap) ? r.mcap : "") },
          { label: "Monthly volume", render: (r) => fmtUSD(r.volume, true), raw: (r) => (isNum(r.volume) ? r.volume : "") },
          { label: "Circulating supply", render: (r) => (isNum(r.supply) ? Math.round(r.supply).toLocaleString("en-US") : DASH), raw: (r) => (isNum(r.supply) ? r.supply : "") },
        ]} />
    </div>
  );
}

/* ============================ Technical Analysis ============================ */
function Candle(props: Props) {
  const { x, width, payload, log } = props;
  const { open, close, high, low } = payload;
  if (![open, close, high, low, props.y, props.height].every(isNum)) return null;
  const y = Math.min(props.y, props.y + props.height), h = Math.abs(props.height);
  const color = close >= open ? C.up : C.down;
  // position inside the bar: linear, or logarithmic when the price axis is logarithmic
  const f = (v) => (high > low ? (log ? Math.log(high / v) / Math.log(high / low) : (high - v) / (high - low)) : 0);
  const yo = y + h * f(open), yc = y + h * f(close), cx = x + width / 2, bw = Math.max(1, width * 0.7);
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + h} stroke={color} strokeWidth={1} />
      <rect x={cx - bw / 2} y={Math.min(yo, yc)} width={bw} height={Math.max(1, Math.abs(yc - yo))} fill={color} />
    </g>
  );
}
function MiniLine({ title, subtitle, rows, dataKey, name, color, fmtTick, fmtTip, domain, ticks, refs = [], width = 48, area, tick, gap }: Props) {
  const Chart = area ? AreaChart : LineChart;
  return (
    <ChartCard title={title} height={220} subtitle={subtitle} empty={rows.filter((r) => isNum(r[dataKey])).length < 2 ? "Not enough monthly observations in this window for this measure." : null}>
      <ResponsiveContainer>
        <Chart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          {grid}
          <XAxis dataKey="date" {...axis} tickFormatter={tick} minTickGap={gap} />
          <YAxis {...axis} width={width} tickFormatter={fmtTick} domain={domain || ["auto", "auto"]} ticks={ticks} />
          <Tooltip {...tipProps} content={<Tip fmt={{ default: fmtTip }} />} />
          {refs.map((y) => <ReferenceLine key={y} y={y} stroke={C.faint} strokeDasharray={y === 0 ? undefined : "4 4"} />)}
          {area ? <Area name={name} type="monotone" dataKey={dataKey} stroke={color} fill={color} fillOpacity={0.15} strokeWidth={1.3} {...noAnim} />
            : <Line name={name} type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} {...noAnim} />}
        </Chart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
function Technical({ asset }: Props) {
  const { data, tf } = useApp();
  const series = asset === "BTC" ? data.btc : data.eth;
  const a = ASSETS[asset];
  const [mode, setMode] = useState("line");
  const [scale, setScale] = useState("linear");
  const [levels, setLevels] = useState(true);
  const w = useMemo(() => windowRows(series.rows, tf), [series, tf]);
  const st = useMemo(() => windowStats(w), [w]);
  const d12 = useMemo(() => donchian(series.rows, 12), [series]);
  const d24 = useMemo(() => donchian(series.rows, 24), [series]);
  const years = useMemo(() => calendarYears(series.rows), [series]);
  const cmp = useMemo(() => {
    if (asset !== "ETH" || data.btc.rows.length < 2) return [];
    const p = withBase(windowRows(alignSeries(data.btc.rows, data.eth.rows), tf));
    return p.length < 2 ? [] : p.map((r) => ({ date: r.date, btc: r.bc / p[0].bc - 1, eth: r.ec / p[0].ec - 1, ratio: r.ec / r.bc }));
  }, [asset, data, tf]);
  if (series.rows.length < 2) return <NeedData what={`No ${a.name} monthly data loaded`} />;
  const last = series.rows[series.rows.length - 1];
  const candles = mode === "candles" && series.hasOHLC, log = scale === "log";
  const horizons = [["1 month", 1], ["3 months", 3], ["6 months", 6], ["12 months", 12], ["24 months", 24], ["36 months", 36], ["5 years", 60]].map(([horizon, m]: [string, number]) => {
    const ret = trailingReturn(series.rows, m);
    return { horizon, ret, ann: isNum(ret) && m > 12 ? Math.pow(1 + ret, PER_YEAR / m) - 1 : null };
  });
  const fullM = last.t - series.rows[0].t, fullRet = last.close / series.rows[0].close - 1;
  horizons.push({ horizon: `Full dataset (${fullM} months, from ${ymLabel(series.rows[0].date)} close)`, ret: fullRet, ann: series.quality.missing.length ? null : Math.pow(1 + fullRet, PER_YEAR / fullM) - 1 });
  const vsSma = isNum(last.sma24) ? last.close / last.sma24 - 1 : null;
  const tick = xTick(w), gap = xGap(w);
  const mini = { rows: w, tick, gap, color: a.color };
  return (
    <div className="space-y-4">
      <Provenance rows={w} full={series.rows} />
      <KpiRow cols={6}>
        <Kpi label={`${asset}/USD monthly close`} value={fmtUSD(last.close)} sub={ymLabel(last.date)} />
        <Kpi label={`Return, ${tf}`} value={fmtPct(st.ret, 1)} tone={moveColor(st.ret)} sub={st.start ? `from ${ymLabel(st.start.date)} close` : null} />
        <Kpi label="Annualized volatility" value={fmtPct(st.annVol, 1, false)} sub={isNum(st.annVol) ? `${fmtPct(st.mVol, 1, false)} monthly, ${st.nRet} returns` : "Needs 6 monthly returns"} />
        <Kpi label="Maximum drawdown" value={fmtPct(st.mdd, 1)} sub={st.dd && st.dd.mdd < 0 ? `${ymLabel(st.dd.peakDate)} to ${ymLabel(st.dd.troughDate)}` : "Monthly closes"} />
        <Kpi label="RSI 14, monthly" value={fmtNum(last.rsi, 1)} sub={isNum(last.rsi) ? (last.rsi >= 70 ? "Above 70" : last.rsi <= 30 ? "Below 30" : "Between 30 and 70") : "Needs 15 consecutive months"} />
        <Kpi label="Close vs SMA 24" value={fmtPct(vsSma, 1)} tone={moveColor(vsSma)} sub={isNum(last.sma24) ? `SMA 24 ${fmtUSD(last.sma24)}` : "Needs 24 consecutive months"} />
      </KpiRow>
      <ChartCard title={`${asset}/USD monthly price with SMA 12 and SMA 24`} height={380}
        legend={[{ label: candles ? "Monthly candles" : "Monthly close", color: candles ? C.text : a.color }, { label: "SMA 12 (12-month average)", color: C.slate }, { label: "SMA 24 (24-month average)", color: C.amber }, ...(levels && d12 ? [{ label: "12-month high / low", color: C.faint, dash: true }] : [])]}
        subtitle={`One point per calendar month. Averages use the months before the window where the dataset has them.${series.hasOHLC ? "" : " Candles need open, high and low columns."}`}
        actions={<>
          <Seg label="Chart type" value={candles ? "candles" : "line"} onChange={setMode} options={[{ value: "line", label: "Line" }, { value: "candles", label: "Candles", disabled: !series.hasOHLC, hint: "File has no open, high and low" }]} />
          <Seg label="Price scale" value={scale} onChange={setScale} options={[{ value: "linear", label: "Linear" }, { value: "log", label: "Log" }]} />
          <Seg label="Range levels" value={levels ? "on" : "off"} onChange={(v) => setLevels(v === "on")} options={[{ value: "on", label: "Levels on" }, { value: "off", label: "Off" }]} />
        </>}>
        <ResponsiveContainer>
          <ComposedChart data={w} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            {grid}
            <XAxis dataKey="date" {...axis} tickFormatter={tick} minTickGap={gap} />
            <YAxis {...axis} width={68} scale={log ? "log" : "auto"} domain={log ? [(min) => min * 0.9, (max) => max * 1.1] : ["auto", "auto"]} allowDataOverflow={log} tickFormatter={(v) => fmtUSD(v, true)} />
            <Tooltip {...tipProps} content={<Tip fmt={{ default: fmtUSD, ohlc: candles }} />} />
            {candles ? <Bar name="Range" dataKey="hl" shape={<Candle log={log} />} isAnimationActive={false} />
              : <Line name="Close" type="monotone" dataKey="close" stroke={a.color} strokeWidth={1.8} {...noAnim} />}
            <Line name="SMA 12" type="monotone" dataKey="sma12" stroke={C.slate} strokeWidth={1.2} {...noAnim} />
            <Line name="SMA 24" type="monotone" dataKey="sma24" stroke={C.amber} strokeWidth={1.2} {...noAnim} />
            {levels && d12 && <ReferenceLine y={d12.resistance} stroke={C.slate} strokeDasharray="5 4" label={{ value: `12M high ${fmtUSD(d12.resistance, true)}`, fill: C.muted, fontSize: 10, position: "insideTopRight" }} />}
            {levels && d12 && <ReferenceLine y={d12.support} stroke={C.slate} strokeDasharray="5 4" label={{ value: `12M low ${fmtUSD(d12.support, true)}`, fill: C.muted, fontSize: 10, position: "insideBottomRight" }} />}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>
      <p className="text-xs px-1" style={{ color: C.faint, lineHeight: 1.5 }}>
        Range levels are Donchian extremes: the lowest low and highest high of the latest 12 months{series.hasOHLC ? "" : " (closes, because the file has no high or low)"}. They describe the recent range and are not predictions.
        {d24 ? ` 24-month range: ${fmtUSD(d24.support)} to ${fmtUSD(d24.resistance)}.` : ""}{!d12 ? " The levels need 12 consecutive months." : " A level outside the visible price range is not drawn."}
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Monthly returns" height={220} subtitle="Percentage change from the previous month-end close.">
          <ResponsiveContainer>
            <BarChart data={w} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              {grid}
              <XAxis dataKey="date" {...axis} tickFormatter={tick} minTickGap={gap} />
              <YAxis {...axis} width={52} tickFormatter={(v) => fmtPct(v, 0)} />
              <Tooltip {...barTip} content={<Tip fmt={{ default: (v) => fmtPct(v, 1) }} />} />
              <ReferenceLine y={0} stroke={C.faint} />
              <Bar name="Monthly return" dataKey="ret" isAnimationActive={false}>
                {w.map((r) => <Cell key={r.date} fill={r.ret >= 0 ? C.up : C.down} fillOpacity={0.7} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <MiniLine {...mini} title="Rolling 12-month return" subtitle="Close divided by the close 12 months earlier, minus one." dataKey="ret12" name="12-month return" fmtTick={(v) => fmtPct(v, 0)} fmtTip={(v) => fmtPct(v, 1)} refs={[0]} width={56} />
        <MiniLine {...mini} title="RSI 14, monthly" subtitle="Wilder smoothing over 14 monthly price changes. Reference lines at 30 and 70." dataKey="rsi" name="RSI 14" fmtTip={(v) => fmtNum(v, 1)} domain={[0, 100]} ticks={[0, 30, 50, 70, 100]} refs={[30, 70]} width={36} />
        <MiniLine {...mini} title="Rolling 12-month volatility, annualized" subtitle="Standard deviation of the last 12 monthly returns, multiplied by the square root of 12." dataKey="vol12" name="12-month volatility" fmtTick={(v) => fmtPct(v, 0, false)} fmtTip={(v) => fmtPct(v, 1, false)} />
        <MiniLine {...mini} area color={C.down} title="Drawdown from record monthly close" subtitle="Distance below the highest monthly close reached so far in the whole dataset." dataKey="ddAth" name="Drawdown" fmtTick={(v) => fmtPct(v, 0, false)} fmtTip={(v) => fmtPct(v, 1)} />
        <ChartCard title="Monthly trading volume" height={220} subtitle="USD volume for each month as reported by the source. Bar color shows the month's return."
          empty={!series.hasVolume ? "This file has no volume column." : null}>
          <ResponsiveContainer>
            <BarChart data={w} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              {grid}
              <XAxis dataKey="date" {...axis} tickFormatter={tick} minTickGap={gap} />
              <YAxis {...axis} width={64} tickFormatter={(v) => fmtUSD(v, true)} />
              <Tooltip {...barTip} content={<Tip fmt={{ default: (v) => fmtUSD(v, true) }} />} />
              <Bar name="Monthly volume" dataKey="volume" isAnimationActive={false}>
                {w.map((r) => <Cell key={r.date} fill={r.up ? C.up : C.down} fillOpacity={0.55} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
      {series.quality.zeroVol > 0 && <p className="text-xs px-1" style={{ color: C.faint }}>The source reports zero volume for {series.quality.zeroVol} month(s). Those values are shown as supplied and are not estimated.</p>}
      {asset === "ETH" && (
        <ChartCard title="BTC versus ETH cumulative return" height={280} subtitle={cmp.length ? `Month-end closes, rebased to 0% at the ${ymLabel(cmp[0].date)} close. ETH/BTC ratio moved from ${cmp[0].ratio.toFixed(5)} to ${cmp[cmp.length - 1].ratio.toFixed(5)}.` : ""}
          legend={[{ label: "BTC", color: C.pink }, { label: "ETH", color: C.purple }]}
          empty={cmp.length < 2 ? "The comparison needs BTC and ETH data for the same calendar months." : null}>
          <ResponsiveContainer>
            <LineChart data={cmp} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              {grid}
              <XAxis dataKey="date" {...axis} tickFormatter={xTick(cmp)} minTickGap={xGap(cmp)} />
              <YAxis {...axis} width={56} tickFormatter={(v) => fmtPct(v, 0)} />
              <Tooltip {...tipProps} content={<Tip fmt={{ default: (v) => fmtPct(v, 1) }} />} />
              <ReferenceLine y={0} stroke={C.faint} />
              <Line name="BTC" type="monotone" dataKey="btc" stroke={C.pink} strokeWidth={1.6} {...noAnim} />
              <Line name="ETH" type="monotone" dataKey="eth" stroke={C.purple} strokeWidth={1.6} {...noAnim} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
      <ChartCard title={`${asset} calendar-year returns`} height={240} subtitle="December close to December close, across the whole dataset. Faded bars are incomplete years and are labelled in the table.">
        <ResponsiveContainer>
          <BarChart data={years} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            {grid}
            <XAxis dataKey="year" {...axis} minTickGap={12} />
            <YAxis {...axis} width={60} tickFormatter={(v) => fmtPct(v, 0)} />
            <Tooltip {...barTip} content={<Tip fmt={{ default: (v) => fmtPct(v, 1) }} />} />
            <ReferenceLine y={0} stroke={C.faint} />
            <Bar name="Calendar-year return" dataKey="ret" isAnimationActive={false}>
              {years.map((r) => <Cell key={r.year} fill={r.ret >= 0 ? C.up : C.down} fillOpacity={r.full ? 0.75 : 0.3} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Table caption={`${asset} returns by horizon`} csvName={`pinkshazam-${asset.toLowerCase()}-returns-monthly.csv`} rows={horizons}
          note={`Whole calendar months ending at the ${ymLabel(last.date)} close. Annualized figures compound the total return to 12 months.`}
          cols={[{ label: "Horizon", key: "horizon", left: true },
            { label: "Total return", csv: "Total return (%)", render: (r) => (isNum(r.ret) ? fmtPct(r.ret, 1) : "Insufficient history"), color: (r) => moveColor(r.ret), raw: (r) => pctRaw(r.ret) },
            { label: "Annualized", csv: "Annualized (%)", render: (r) => fmtPct(r.ann, 1), color: (r) => moveColor(r.ann), raw: (r) => pctRaw(r.ann) }]} />
        <Table caption={`${asset} calendar-year returns`} csvName={`pinkshazam-${asset.toLowerCase()}-calendar-years.csv`} rows={[...years].reverse()}
          cols={[{ label: "Year", key: "year", left: true }, { label: "Return", csv: "Return (%)", render: (r) => fmtPct(r.ret, 1), color: (r) => moveColor(r.ret), raw: (r) => pctRaw(r.ret) }, { label: "Basis", key: "note", left: true, color: (r) => (r.full ? C.muted : C.amber) }]} />
      </div>
      <Table caption={`${asset} monthly return profile, ${tf}`} csvName={`pinkshazam-${asset.toLowerCase()}-profile-monthly.csv`}
        rows={[
          { k: "Monthly returns in window", v: String(st.nRet) }, { k: "Average monthly return", v: fmtPct(st.meanRet, 2), c: moveColor(st.meanRet) },
          { k: "Best month", v: isNum(st.best) ? `${fmtPct(st.best, 1)} (${ymLabel(st.bestDate)})` : DASH, c: moveColor(st.best) },
          { k: "Worst month", v: isNum(st.worst) ? `${fmtPct(st.worst, 1)} (${ymLabel(st.worstDate)})` : DASH, c: moveColor(st.worst) },
          { k: "Share of positive months", v: fmtPct(st.posShare, 1, false) }, { k: "Monthly volatility", v: fmtPct(st.mVol, 1, false) },
          { k: "Annualized volatility (x sqrt 12)", v: fmtPct(st.annVol, 1, false) }, { k: "Maximum drawdown, monthly closes", v: fmtPct(st.mdd, 1) },
        ]}
        cols={[{ label: "Metric", key: "k", left: true }, { label: "Value", key: "v", color: (r) => r.c || C.text }]} />
    </div>
  );
}

/* =========================== Risk & Performance =========================== */
function Risk() {
  const { data, tf, setTf, rf, rfText, setRfText } = useApp();
  const [show, setShow] = useState({ BTC: true, ETH: true });
  const [range, setRange] = useState({ start: "", end: "" });
  const custom = !!(range.start || range.end);
  const has = { BTC: data.btc.rows.length > 1, ETH: data.eth.rows.length > 1 };
  const both = has.BTC && has.ETH;
  const aligned = useMemo(() => alignSeries(data.btc.rows, data.eth.rows), [data]);
  // With both assets loaded every figure uses the shared calendar months, so BTC and ETH are compared like for like.
  const shared = useMemo(() => new Set(aligned.map((r) => r.date)), [aligned]);
  const bRows = useMemo(() => (both ? data.btc.rows.filter((r) => shared.has(r.date)) : data.btc.rows), [data, both, shared]);
  const eRows = useMemo(() => (both ? data.eth.rows.filter((r) => shared.has(r.date)) : data.eth.rows), [data, both, shared]);
  const sel = custom ? range : null;
  const al = useMemo(() => windowRows(aligned, tf, sel), [aligned, tf, sel]);
  const wb = useMemo(() => windowRows(bRows, tf, sel), [bRows, tf, sel]);
  const we = useMemo(() => windowRows(eRows, tf, sel), [eRows, tf, sel]);
  const sb = useMemo(() => windowStats(wb, rf), [wb, rf]), se = useMemo(() => windowStats(we, rf), [we, rf]);
  const corr = useMemo(() => windowCorr(al), [al]);
  const chartRows = useMemo(() => {
    if (both) { const p = withBase(al); return p.map((r) => ({ ...r, btc: r.bc / p[0].bc - 1, eth: r.ec / p[0].ec - 1 })); }
    const p = withBase(has.BTC ? wb : we), k = has.BTC ? "btc" : "eth";
    return p.map((r) => ({ date: r.date, [k]: r.close / p[0].close - 1, [has.BTC ? "bvol" : "evol"]: r.vol12 }));
  }, [both, al, wb, we, has.BTC]);
  if (!has.BTC && !has.ETH) return <NeedData />;
  const toggle = (k) => setShow((s) => { const n = { ...s, [k]: !s[k] }; return n.BTC || n.ETH ? n : s; });
  const months = (both ? aligned : has.BTC ? data.btc.rows : data.eth.rows).map((r) => r.date);
  const view = both ? al : has.BTC ? wb : we;
  const tick = xTick(chartRows), gap = xGap(chartRows);
  const lines = (kb, ke) => [
    show.BTC && has.BTC && <Line key="b" name="BTC" type="monotone" dataKey={kb} stroke={C.pink} strokeWidth={1.6} {...noAnim} />,
    show.ETH && has.ETH && <Line key="e" name="ETH" type="monotone" dataKey={ke} stroke={C.purple} strokeWidth={1.6} {...noAnim} />,
  ];
  const rfLabel = `${(rf * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const need12 = "Needs 12 monthly returns";
  const metricRows = [
    ["Monthly observations", (s) => String(s.n)], ["Monthly returns used", (s) => String(s.nRet)],
    ["Period return", (s) => fmtPct(s.ret, 1), (s) => s.ret],
    ["Annualized return (CAGR)", (s) => (isNum(s.cagr) ? fmtPct(s.cagr, 1) : "Needs 12 months"), (s) => s.cagr],
    ["Average monthly return", (s) => fmtPct(s.meanRet, 2), (s) => s.meanRet],
    ["Monthly volatility", (s) => fmtPct(s.mVol, 1, false)], ["Annualized volatility (x sqrt 12)", (s) => fmtPct(s.annVol, 1, false)],
    ["Maximum drawdown, monthly closes", (s) => fmtPct(s.mdd, 1)],
    [`Sharpe ratio, annualized (rf ${rfLabel})`, (s) => (isNum(s.sharpe) ? fmtNum(s.sharpe) : need12)],
    [`Sortino ratio, annualized (rf ${rfLabel})`, (s) => (isNum(s.sortino) ? fmtNum(s.sortino) : need12)],
    ["Calmar ratio", (s) => (isNum(s.calmar) ? fmtNum(s.calmar) : "Needs 12 months")],
    ["Best month", (s) => (isNum(s.best) ? `${fmtPct(s.best, 1)} (${ymLabel(s.bestDate)})` : DASH), (s) => s.best],
    ["Worst month", (s) => (isNum(s.worst) ? `${fmtPct(s.worst, 1)} (${ymLabel(s.worstDate)})` : DASH), (s) => s.worst],
    ["Share of positive months", (s) => fmtPct(s.posShare, 1, false)],
  ].map(([metric, f, sign]: [string, (s: Stats) => string, ((s: Stats) => Num)?]) => ({ metric, btc: has.BTC ? f(sb) : DASH, eth: has.ETH ? f(se) : DASH, cb: sign && has.BTC ? moveColor(sign(sb)) : C.text, ce: sign && has.ETH ? moveColor(sign(se)) : C.text }));
  const box = { background: C.raised, color: C.text, border: `1px solid ${C.border}`, colorScheme: "dark" };
  const monthSelect = (k, label) => (
    <label className="text-xs" style={{ color: C.muted }}>
      <div className="mb-1">{label}</div>
      <select aria-label={label} className="px-2 py-1 rounded-md text-xs" style={box} value={range[k]} onChange={(e) => setRange((r) => ({ ...r, [k]: e.target.value }))}>
        <option value="">{k === "start" ? "First available" : "Latest"}</option>
        {months.filter((m) => (k === "start" ? !range.end || m < range.end : !range.start || m > range.start)).map((m) => <option key={m} value={m}>{ymLabel(m)}</option>)}
      </select>
    </label>
  );
  return (
    <div className="space-y-4">
      <Provenance rows={view} full={both ? aligned : has.BTC ? data.btc.rows : data.eth.rows} />
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="text-xs mb-1" style={{ color: C.muted }}>Assets</div>
            <div className="flex gap-2">
              {["BTC", "ETH"].map((k) => (
                <button key={k} type="button" aria-pressed={show[k]} disabled={!has[k]} onClick={() => toggle(k)} className="ps-seg px-3 py-1 rounded-md text-xs font-medium inline-flex items-center gap-2"
                  style={{ border: `1px solid ${show[k] && has[k] ? ASSETS[k].color : C.border}`, color: show[k] && has[k] ? C.text : C.faint, background: show[k] && has[k] ? C.raised : "transparent" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 8, background: show[k] && has[k] ? ASSETS[k].color : C.faint, display: "inline-block" }} />{k}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: C.muted }}>Timeframe</div>
            <Seg label="Timeframe" options={TIMEFRAMES} value={custom ? "" : tf} onChange={(v) => { setRange({ start: "", end: "" }); setTf(v); }} />
          </div>
          {monthSelect("start", "Custom start month")}
          {monthSelect("end", "Custom end month")}
          <label className="text-xs" style={{ color: C.muted }}>
            <div className="mb-1">Risk-free rate, % per year</div>
            <input type="number" min="0" max="25" step="0.25" inputMode="decimal" aria-label="Risk-free rate, percent per year" className="px-2 py-1 rounded-md text-xs" style={{ ...box, width: 96 }} value={rfText} onChange={(e) => setRfText(e.target.value)} />
          </label>
          {custom && <Btn onClick={() => setRange({ start: "", end: "" })}>Clear custom months</Btn>}
        </div>
        <p className="mt-3 text-xs" style={{ color: C.faint, lineHeight: 1.5, maxWidth: 820 }}>
          The risk-free rate is an assumption you set, used by the Sharpe and Sortino ratios. It defaults to 0% and is converted to a monthly rate by compounding.{both ? " With both assets loaded, every figure on this page uses only the calendar months they share." : ""}
        </p>
      </Card>
      <KpiRow cols={4}>
        <Kpi label="BTC annualized volatility" value={has.BTC ? fmtPct(sb.annVol, 1, false) : DASH} sub={has.BTC ? `Max drawdown ${fmtPct(sb.mdd, 1)}` : "Not loaded"} />
        <Kpi label="ETH annualized volatility" value={has.ETH ? fmtPct(se.annVol, 1, false) : DASH} sub={has.ETH ? `Max drawdown ${fmtPct(se.mdd, 1)}` : "Not loaded"} />
        <Kpi label="BTC / ETH correlation" value={corr ? fmtNum(corr.r) : DASH} sub={corr ? `Pearson, ${corr.n} monthly returns` : "Needs both assets, 6 shared months"} />
        <Kpi small label={`Sharpe ratio, BTC / ETH (rf ${rfLabel})`} value={isNum(sb.sharpe) || isNum(se.sharpe) ? `${isNum(sb.sharpe) ? fmtNum(sb.sharpe) : "n/a"} / ${isNum(se.sharpe) ? fmtNum(se.sharpe) : "n/a"}` : DASH} sub={isNum(sb.sharpe) || isNum(se.sharpe) ? "Annualized from monthly returns" : need12} />
      </KpiRow>
      {chartRows.length < 2 ? <Card className="p-4"><Empty text="The selected months contain fewer than two observations. Widen the range." /></Card> : (
        <>
          <ChartCard title="Cumulative return" height={300} subtitle={`Month-end closes, rebased to 0% at the ${ymLabel(chartRows[0].date)} close.`} legend={[{ label: "BTC", color: C.pink }, { label: "ETH", color: C.purple }]}>
            <ResponsiveContainer>
              <LineChart data={chartRows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                {grid}
                <XAxis dataKey="date" {...axis} tickFormatter={tick} minTickGap={gap} />
                <YAxis {...axis} width={56} tickFormatter={(v) => fmtPct(v, 0)} />
                <Tooltip {...tipProps} content={<Tip fmt={{ default: (v) => fmtPct(v, 1) }} />} />
                <ReferenceLine y={0} stroke={C.faint} />
                {lines("btc", "eth")}
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="Rolling 12-month volatility, annualized" height={240} subtitle="Standard deviation of the last 12 monthly returns, multiplied by the square root of 12.">
              <ResponsiveContainer>
                <LineChart data={chartRows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  {grid}
                  <XAxis dataKey="date" {...axis} tickFormatter={tick} minTickGap={gap} />
                  <YAxis {...axis} width={48} tickFormatter={(v) => fmtPct(v, 0, false)} />
                  <Tooltip {...tipProps} content={<Tip fmt={{ default: (v) => fmtPct(v, 1, false) }} />} />
                  {lines("bvol", "evol")}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Rolling 12-month BTC / ETH correlation" height={240} subtitle="Pearson correlation of the last 12 monthly returns of each asset."
              empty={!both ? "Correlation needs both BTC and ETH data." : chartRows.filter((r) => isNum(r.corr12)).length < 2 ? "A 12-month correlation needs more months than this window holds." : null}>
              <ResponsiveContainer>
                <LineChart data={chartRows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  {grid}
                  <XAxis dataKey="date" {...axis} tickFormatter={tick} minTickGap={gap} />
                  <YAxis {...axis} width={40} domain={[-1, 1]} ticks={[-1, -0.5, 0, 0.5, 1]} />
                  <Tooltip {...tipProps} content={<Tip fmt={{ default: (v) => fmtNum(v) }} />} />
                  <ReferenceLine y={0} stroke={C.faint} />
                  <Line name="Correlation" type="monotone" dataKey="corr12" stroke={C.slate} strokeWidth={1.5} {...noAnim} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </>
      )}
      <Table caption="Risk and performance metrics for the selection" csvName="pinkshazam-risk-metrics-monthly.csv" rows={metricRows}
        cols={[{ label: "Metric", key: "metric", left: true }, { label: "BTC", key: "btc", color: (r) => r.cb }, { label: "ETH", key: "eth", color: (r) => r.ce }]} />
      <p className="text-xs" style={{ color: C.faint, lineHeight: 1.5 }}>Sharpe and Sortino are withheld below 12 monthly returns, and volatility below 6. Even 12 to 36 monthly returns is a small sample, so treat those ratios as rough. All values describe the past sample only.</p>
    </div>
  );
}

/* =========================== Research & Insights =========================== */
function buildInsights({ data, tf, rf }) {
  const out = { summary: [], structure: [], momentum: [], volatility: [], relative: [], risks: [], conclusions: [] };
  const sets = [data.btc, data.eth].filter((s) => s.rows.length > 1).map((s) => {
    const w = windowRows(s.rows, tf);
    return { s, w, st: windowStats(w, rf), last: s.rows[s.rows.length - 1], name: s.asset };
  });
  if (!sets.length) return out;
  const verb = (v) => (v >= 0 ? "gained" : "lost");
  sets.forEach(({ s, st, last, name }) => {
    if (isNum(st.ret)) out.summary.push(`${name} ${verb(st.ret)} ${fmtPct(Math.abs(st.ret), 1, false)} over the ${st.months} months from the ${ymLabel(st.start.date)} close (${fmtUSD(st.start.close)}) to the ${ymLabel(st.last.date)} close (${fmtUSD(st.last.close)}).`);
    // long-term structure and cycles
    if (isNum(last.sma24) && isNum(last.sma12)) {
      const g = last.close / last.sma24 - 1;
      out.structure.push(`${name}'s ${ymLabel(last.date)} close of ${fmtUSD(last.close)} is ${fmtPct(Math.abs(g), 1, false)} ${g >= 0 ? "above" : "below"} its 24-month average (${fmtUSD(last.sma24)}). The 12-month average (${fmtUSD(last.sma12)}) sits ${last.sma12 >= last.sma24 ? "above" : "below"} the 24-month average.`);
    } else out.structure.push(`${name} has ${s.rows.length} monthly observations, too few consecutive months for a 24-month average. No trend-structure statement is made.`);
    const rec = s.record;
    if (rec) {
      out.structure.push(last.ddAth === 0
        ? `${name}'s latest close is its highest monthly close in the dataset.`
        : `${name}'s highest monthly close in the dataset is ${fmtUSD(rec.close)} (${ymLabel(rec.date)}). The latest close is ${fmtPct(Math.abs(last.ddAth), 1, false)} below it, ${rec.under} month(s) later.`);
      if (rec.longest.months > 0) out.structure.push(`${name}'s longest stretch below a prior record close lasted ${rec.longest.months} months, starting after ${ymLabel(rec.longest.from)}${rec.longest.to ? ` and ending with a new record in ${ymLabel(rec.longest.to)}` : " and still running at the end of the dataset"}.`);
    }
    const yrs = calendarYears(s.rows).filter((y) => y.full);
    if (yrs.length >= 3) {
      const hi = yrs.reduce((a, y) => (y.ret > a.ret ? y : a)), lo = yrs.reduce((a, y) => (y.ret < a.ret ? y : a));
      out.structure.push(`Across ${yrs.length} complete calendar years, ${name}'s strongest was ${hi.year} (${fmtPct(hi.ret, 0)}) and its weakest ${lo.year} (${fmtPct(lo.ret, 0)}); ${yrs.filter((y) => y.ret > 0).length} of the ${yrs.length} years closed higher.`);
    }
    // momentum
    if (isNum(last.rsi)) out.momentum.push(`${name}'s monthly RSI 14 reads ${last.rsi.toFixed(1)}, ${last.rsi >= 70 ? "above the conventional 70 threshold" : last.rsi <= 30 ? "below the conventional 30 threshold" : "inside the 30 to 70 band"}. It is built from 14 monthly price changes, so it moves slowly.`);
    else out.momentum.push(`${name}'s monthly RSI 14 is unavailable: it needs 15 consecutive months.`);
    const r3 = trailingReturn(s.rows, 3), r12 = trailingReturn(s.rows, 12);
    if (isNum(r3) && isNum(r12)) out.momentum.push(`${name} trailing returns: ${fmtPct(r3, 1)} over 3 months and ${fmtPct(r12, 1)} over 12 months.`);
    // volatility
    if (isNum(st.annVol)) {
      let t = `${name}'s monthly returns had a standard deviation of ${fmtPct(st.mVol, 1, false)} over the window, or ${fmtPct(st.annVol, 1, false)} annualized (multiplied by the square root of 12), from ${st.nRet} monthly returns.`;
      const all = s.rows.map((r) => r.vol12).filter(isNum), med = median(all);
      if (isNum(last.vol12) && all.length >= 24) t += ` The latest 12-month reading (${fmtPct(last.vol12, 1, false)}) is ${last.vol12 >= med ? "above" : "below"} the dataset median of ${fmtPct(med, 1, false)}.`;
      out.volatility.push(t);
      if (isNum(st.posShare)) out.volatility.push(`${fmtPct(st.posShare, 0, false)} of ${name}'s months in the window closed higher. The best was ${fmtPct(st.best, 1)} (${ymLabel(st.bestDate)}) and the worst ${fmtPct(st.worst, 1)} (${ymLabel(st.worstDate)}).`);
    } else out.volatility.push(`${name} volatility is not reported: the window holds fewer than 6 monthly returns.`);
    if (st.dd && st.dd.mdd < 0) out.risks.push(`${name}'s largest decline between monthly closes in the window was ${fmtPct(st.dd.mdd, 1)}, from ${ymLabel(st.dd.peakDate)} to ${ymLabel(st.dd.troughDate)}. Intra-month lows were deeper than month-end closes show.`);
    if (s.quality.missing.length) out.risks.push(`${name} data is missing ${s.quality.missing.length} month(s) (${s.quality.missing.slice(0, 6).map(ymLabel).join(", ")}${s.quality.missing.length > 6 ? ", and more" : ""}). Nothing is filled in, and indicators restart after each gap.`);
  });
  if (sets.length === 2) {
    const [b, e] = sets;
    const al = windowRows(alignSeries(data.btc.rows, data.eth.rows), tf), corr = windowCorr(al);
    const sameSpan = b.st.start && e.st.start && b.st.start.date === e.st.start.date;
    if (isNum(b.st.ret) && isNum(e.st.ret) && sameSpan) {
      const diff = e.st.ret - b.st.ret;
      out.relative.push(`ETH ${diff >= 0 ? "outperformed" : "underperformed"} BTC by ${Math.abs(diff * 100).toFixed(1)} percentage points over the window (${fmtPct(e.st.ret, 1)} versus ${fmtPct(b.st.ret, 1)}).`);
    } else if (!sameSpan) out.relative.push(`The two windows start in different months (BTC ${ymLabel(b.st.start.date)}, ETH ${ymLabel(e.st.start.date)}), so total returns are not compared here. The Risk & performance page restricts both to shared months.`);
    if (al.length > 0) {
      const a0 = al.base || al[0], a1 = al[al.length - 1], r0 = a0.ec / a0.bc, r1 = a1.ec / a1.bc;
      out.relative.push(`The ETH/BTC ratio moved from ${r0.toFixed(5)} (${ymLabel(a0.date)}) to ${r1.toFixed(5)} (${ymLabel(a1.date)}), a change of ${fmtPct(r1 / r0 - 1, 1)}.`);
    }
    if (sameSpan && isNum(b.st.annVol) && isNum(e.st.annVol)) out.relative.push(`ETH's annualized volatility was ${(e.st.annVol / b.st.annVol).toFixed(2)} times BTC's (${fmtPct(e.st.annVol, 1, false)} versus ${fmtPct(b.st.annVol, 1, false)}).`);
    if (!sameSpan) { /* different spans: no ratio comparison */ }
    else if (isNum(b.st.sharpe) && isNum(e.st.sharpe)) out.relative.push(`With an assumed risk-free rate of ${(rf * 100).toFixed(2)}% a year, the annualized Sharpe ratio from monthly returns was ${b.st.sharpe.toFixed(2)} for BTC and ${e.st.sharpe.toFixed(2)} for ETH.`);
    else out.relative.push("Sharpe ratios are not compared: the window holds fewer than 12 monthly returns.");
    if (corr) {
      out.summary.push(`Monthly returns of the two assets had a correlation of ${corr.r.toFixed(2)} across ${corr.n} shared months.`);
      out.risks.push(`A BTC/ETH correlation of ${corr.r.toFixed(2)} on monthly returns means ${corr.r >= 0.7 ? "the two assets rose and fell together in most months of this sample, so holding both offered limited diversification during it" : corr.r >= 0.3 ? "the two assets were moderately linked in this sample" : "the two assets were only weakly linked in this sample"}.`);
    }
    if (isNum(b.st.ret) && isNum(e.st.ret) && sameSpan) out.conclusions.push(`Over this window ${b.st.ret >= e.st.ret ? "BTC" : "ETH"} delivered the higher return${isNum(b.st.annVol) && isNum(e.st.annVol) ? ` and ${b.st.annVol <= e.st.annVol ? "BTC" : "ETH"} the lower volatility` : ""}.`);
  }
  sets.forEach(({ last, name }) => {
    if (isNum(last.sma24)) out.conclusions.push(`${name} ended the dataset ${last.close >= last.sma24 ? "above" : "below"} its 24-month average${last.ddAth < 0 ? ` and ${fmtPct(Math.abs(last.ddAth), 0, false)} below its record monthly close` : " at a record monthly close"}.`);
  });
  out.risks.push("Monthly sampling: one price per month hides intra-month swings, so volatility and drawdowns here are lower bounds on what a holder experienced. Figures come from a single aggregated source.");
  out.conclusions.push("These statements describe one historical sample. They are not forecasts, signals or investment recommendations.");
  return out;
}
function Research() {
  const { data, tf, rf } = useApp();
  const ins = useMemo(() => buildInsights({ data, tf, rf }), [data, tf, rf]);
  const base = data.btc.rows.length > 1 ? data.btc : data.eth;
  if (base.rows.length < 2) return <NeedData />;
  const w = windowRows(base.rows, tf);
  const facts = [data.btc, data.eth].filter((x) => x.rows.length > 1).map((x) => ({ name: x.asset, st: windowStats(windowRows(x.rows, tf), rf), last: x.rows[x.rows.length - 1], n: x.rows.length, cov: coverage(x.rows) }));
  const factRows = [
    ["Dataset coverage", (x) => x.cov], ["Monthly observations", (x) => String(x.n)],
    ["Latest monthly close", (x) => fmtUSD(x.last.close)], [`Return, ${tf}`, (x) => fmtPct(x.st.ret, 1), (x) => x.st.ret],
    ["Annualized volatility", (x) => fmtPct(x.st.annVol, 1, false)], ["Maximum drawdown, monthly closes", (x) => fmtPct(x.st.mdd, 1)],
    ["RSI 14, monthly", (x) => fmtNum(x.last.rsi, 1)], ["Close vs SMA 24", (x) => (isNum(x.last.sma24) ? fmtPct(x.last.close / x.last.sma24 - 1, 1) : "n/a"), (x) => (isNum(x.last.sma24) ? x.last.close / x.last.sma24 - 1 : null)],
    ["Versus record monthly close", (x) => (x.last.ddAth === 0 ? "At record" : fmtPct(x.last.ddAth, 1))],
  ];
  const sections = [
    ["Executive summary", ins.summary], ["Market structure and cycles", ins.structure], ["Momentum analysis", ins.momentum],
    ["Volatility assessment", ins.volatility], ["Relative performance", ins.relative], ["Key risk factors", ins.risks], ["Research conclusions", ins.conclusions],
  ];
  return (
    <div className="space-y-4">
      <Provenance rows={w} full={base.rows} />
      <Card className="px-5 py-6 md:px-10 md:py-8">
        <div className="mx-auto" style={{ maxWidth: 720 }}>
          <div className="text-xs" style={{ color: C.pink }}>PinkShazam research note</div>
          <h2 className="mt-1 text-2xl md:text-3xl" style={{ fontFamily: SERIF, color: C.text, letterSpacing: "-0.01em", lineHeight: 1.2 }}>BTC and ETH long-term review, {tf === "ALL" ? "full dataset" : `trailing ${TF_TEXT[tf]}`}</h2>
          <p className="mt-2 text-xs" style={{ color: C.muted, lineHeight: 1.5 }}>Monthly data from {data.source}. Every figure below is recomputed from the loaded files when the timeframe changes.</p>
          <div className="mt-6" style={{ overflowX: "auto" }}>
            <table className="w-full text-sm" style={{ fontVariantNumeric: "tabular-nums", borderCollapse: "collapse" }}>
              <thead><tr>{["Key figures", ...facts.map((f) => f.name)].map((h, i) => <th key={h} scope="col" className={`py-2 text-xs font-medium ${i ? "text-right" : "text-left"}`} style={{ color: C.muted, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
              <tbody>
                {factRows.map(([label, f, tone]: [string, (x: any) => string, ((x: any) => Num)?]) => (
                  <tr key={label}><td className="py-2 pr-4" style={{ color: C.slate, borderBottom: `1px solid ${C.border}` }}>{label}</td>
                    {facts.map((x) => <td key={x.name} className="py-2 pl-3 text-right whitespace-nowrap" style={{ color: tone ? moveColor(tone(x)) : C.text, borderBottom: `1px solid ${C.border}` }}>{f(x)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {sections.map(([title, items]) => (
            <section key={title} className="mt-7 pt-5" style={{ borderTop: `1px solid ${C.border}` }}>
              <h3 className="text-sm font-semibold" style={{ color: C.text }}>{title}</h3>
              {items.length ? items.map((t, i) => (
                <p key={i} className="mt-3 text-base" style={{ fontFamily: SERIF, color: "#CDD1DD", lineHeight: 1.65 }}>{t}</p>
              )) : <p className="mt-3 text-sm" style={{ color: C.muted }}>The loaded data does not support a statement here. This usually means only one asset is loaded.</p>}
            </section>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ============================== Data Sources ============================== */
function seriesWarnings(s) {
  const q = s.quality, out = [];
  if (q.missing.length) out.push(`Missing ${q.missing.length} month(s): ${q.missing.slice(0, 8).map(ymLabel).join(", ")}${q.missing.length > 8 ? ", and more" : ""}. Nothing is filled in. Indicators restart after each gap.`);
  if (q.dupes) out.push(`${q.dupes} duplicate month(s) found. The last row for each month was kept.`);
  if (q.dropped) out.push(`${q.dropped} row(s) dropped: unreadable date or missing close.`);
  if (q.excludedLast) out.push(`${ymLabel(q.excludedLast)} is the last row and does not cover a complete month, so it is left out of every calculation.`);
  if (q.partial.length) out.push(`${q.partial.length} record(s) do not span a full calendar month: ${q.partial.slice(0, 6).map(ymLabel).join(", ")}. They are kept and marked in tooltips.`);
  if (q.firstLate) out.push(`First record (${ymLabel(s.rows[0].date)}): its high and low were both recorded on or after ${q.firstLate}, so the source's history probably starts late in that month. Its open, high, low and volume may cover only part of the month. Its close is still a month-end close.`);
  if (q.unknown) out.push(`${q.unknown} record(s) have no period start and end, so whether each covers a complete month cannot be checked from the file.`);
  if (q.zeroVol) out.push(`Volume is reported as zero for ${q.zeroVol} month(s). Shown as supplied.`);
  if (!s.quoteOk) out.push(`Quote currency ${s.quote}. Figures are labelled USD only if that is what the file contains.`);
  if (s.provider !== "CoinMarketCap") out.push("The provider could not be identified from the file, so it is labelled as user-supplied.");
  return out;
}
function UploadTile({ asset }: Props) {
  const { data, applyCsv } = useApp();
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef(null);
  const a = ASSETS[asset];
  const mine = data ? data[asset.toLowerCase()] : null;
  const cur = mine && mine.rows.length ? mine : null;
  const take = (f) => {
    if (!f) return;
    if (f.size > 20e6) { setErr("That file is larger than 20 MB. A monthly history file is normally well under 1 MB."); return; }
    const rd = new FileReader();
    rd.onerror = () => setErr(`${f.name} could not be read.`);
    rd.onload = () => {
      try { applyCsv(asset, parseCsv(asset, String(rd.result), f.name)); setErr(""); }
      catch (ex) { setErr(ex.message); }
    };
    rd.readAsText(f);
  };
  const otherRe = asset === "BTC" ? /eth/i : /btc|bitcoin/i, ownRe = asset === "BTC" ? /btc|bitcoin/i : /eth/i;
  const warnings = cur ? seriesWarnings(cur) : [];
  if (cur && cur.fileName && otherRe.test(cur.fileName) && !ownRe.test(cur.fileName)) warnings.unshift(`The file name suggests this is not ${a.name} data. Check that it is in the right slot.`);
  const q = cur && cur.quality;
  const facts = cur ? [
    ["Asset", `${a.name} (${asset}/USD)`],
    ["Source", `${cur.provider}, identified from the ${cur.providerBasis}`],
    ["File", `${cur.fileName}${cur.bundled ? " (bundled with this dashboard)" : ""}`],
    ["Frequency", "Monthly, one record per calendar month"],
    ["First observation", ymLabel(cur.rows[0].date)],
    ["Last observation", ymLabel(cur.rows[cur.rows.length - 1].date)],
    ["Monthly records", `${q.kept} used of ${q.input} read`],
    ["Missing months", q.missing.length ? String(q.missing.length) : "None"],
    ["Complete months", q.unknown === q.kept ? "Cannot be checked: no period start and end in file" : `${q.complete} of ${q.kept} span the full calendar month by their own start and end stamps`],
    ["Quote currency", cur.quote],
    ["Columns available", cur.detected.join(", ")],
  ] : [];
  return (
    <div className="rounded-lg p-5 flex flex-col min-w-0" data-upload={asset}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files && e.dataTransfer.files[0]); }}
      style={{ border: `1px ${cur ? "solid" : "dashed"} ${over ? C.pink : cur ? a.color : C.border}`, background: over ? "rgba(236,72,153,0.07)" : C.raised, minHeight: 190 }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span style={{ width: 8, height: 8, borderRadius: 8, background: a.color, display: "inline-block" }} />
          <span className="text-sm font-semibold" style={{ color: C.text }}>{a.name}</span>
          <span className="text-xs" style={{ color: C.muted }}>{asset}/USD</span>
        </div>
        {cur && <span className="inline-flex items-center gap-1 text-xs" style={{ color: C.text }}><Check size={13} style={{ color: a.color }} />In use</span>}
      </div>
      <div className="flex-1 mt-3 text-xs" style={{ lineHeight: 1.6 }}>
        {cur ? (
          <>
            <dl>
              {facts.map(([k, v]) => (
                <div key={k} className="flex gap-3 py-1" style={{ borderBottom: `1px solid ${C.border}` }}>
                  <dt className="shrink-0" style={{ color: C.faint, width: 118 }}>{k}</dt>
                  <dd style={{ color: C.slate, wordBreak: "break-word", margin: 0 }}>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3" style={{ color: C.muted }}>Validation: {warnings.length ? `${warnings.length} note(s)` : "no issues found"}</div>
            {warnings.map((w) => <div key={w} className="mt-1" style={{ color: C.amber }}>{w}</div>)}
          </>
        ) : (
          <p style={{ color: C.muted }}>Drop the {a.name} monthly CSV here, or choose a file. It is checked for monthly frequency and applied as soon as it is read.</p>
        )}
      </div>
      {err && <div role="alert" className="mt-3 text-xs rounded-md px-3 py-2" style={{ color: "#FCA5A5", border: `1px solid ${C.down}`, background: "rgba(239,68,68,0.08)" }}>{err}</div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Btn primary={!cur} onClick={() => input.current && input.current.click()}><Upload size={14} />{cur ? "Replace file" : `Choose ${asset} file`}</Btn>
        {cur && <Btn onClick={() => { applyCsv(asset, null); setErr(""); }}>Remove</Btn>}
        <input ref={input} type="file" accept=".csv,.txt,text/csv" className="hidden" aria-label={`${a.name} monthly CSV file`} onChange={(e) => { take(e.target.files && e.target.files[0]); e.target.value = ""; }} />
      </div>
    </div>
  );
}
function DataSources() {
  const { data, restore, go, error } = useApp();
  const template = "timeOpen;timeClose;open;high;low;close;volume;marketCap\r\nYYYY-MM-01T00:00:00.000Z;YYYY-MM-DDT23:59:59.999Z;;;;;;\r\n";
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold" style={{ color: C.text }}>Monthly price history</h3>
            <p className="mt-1 text-xs" style={{ color: C.muted, maxWidth: 700, lineHeight: 1.5 }}>One CSV per asset, one row per calendar month. CoinMarketCap monthly exports load as they are. Daily or weekly files are rejected, never resampled. Files are read in your browser and are not sent anywhere.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(!data || !data.bundled) && <Btn onClick={restore}><RotateCcw size={14} />Restore bundled files</Btn>}
            <a href={"data:text/csv;charset=utf-8," + encodeURIComponent(template)} download="pinkshazam-monthly-template.csv" className="ps-btn inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium" style={{ background: C.raised, color: C.text, border: `1px solid ${C.border}`, textDecoration: "none" }}><Download size={14} />CSV template</a>
          </div>
        </div>
        {error && <div role="alert" className="mt-3 text-xs" style={{ color: C.amber }}>{error}</div>}
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <UploadTile asset="BTC" />
          <UploadTile asset="ETH" />
        </div>
        {data && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-md text-xs" style={{ background: C.raised, border: `1px solid ${C.border}`, color: C.slate }}>
            <span>{data.bundled ? "The dashboard opens with the two CoinMarketCap monthly exports supplied for this project. Their contents are embedded unchanged." : "Your files now drive every section."}{data.btc.rows.length && data.eth.rows.length ? "" : " Add the other asset to unlock correlation and relative performance."}</span>
            <Btn primary onClick={() => go("overview")}>Open market overview</Btn>
          </div>
        )}
      </Card>
      <Table caption="What a monthly CSV can contain" rows={[
        { f: "Month", r: "Required", a: "timeOpen, date, timestamp, month", d: "Any date inside the month. The calendar month is read from the period start when present, otherwise from the date." },
        { f: "close", r: "Required", a: "close, price", d: "Month-end closing price in USD. Rows with a missing or non-positive close are dropped." },
        { f: "Period start and end", r: "Optional", a: "timeOpen, timeClose", d: "Lets the dashboard confirm each record spans a complete calendar month. A final record that does not is left out." },
        { f: "open, high, low", r: "Optional", a: "open, high, low", d: "Enables monthly candles and high/low based range levels. Needed on every row." },
        { f: "volume", r: "Optional", a: "volume", d: "Total USD volume for the month, shown as supplied." },
        { f: "market cap, supply", r: "Optional", a: "marketCap, circulatingSupply", d: "Month-end values. Market cap is needed in both files for the market cap chart." },
      ]} cols={[{ label: "Field", key: "f", left: true }, { label: "Status", key: "r", left: true }, { label: "Accepted headers", key: "a", left: true, render: (r) => <span className="whitespace-normal block" style={{ minWidth: 170, color: C.muted }}>{r.a}</span> }, { label: "Notes", left: true, render: (r) => <span className="whitespace-normal block" style={{ minWidth: 260, color: C.muted }}>{r.d}</span> }]} />
    </div>
  );
}

/* =============================== Methodology =============================== */
function Methodology() {
  const { data, rf } = useApp();
  const P = ({ children }) => <p className="mt-2 text-sm" style={{ color: "#C4C9D6", lineHeight: 1.65, maxWidth: 760 }}>{children}</p>;
  const H = ({ children }) => <h3 className="text-sm font-semibold" style={{ color: C.text }}>{children}</h3>;
  const defs = [
    ["Monthly return", "close_m / close_(m-1) - 1", "Simple percentage return between consecutive month-end closes. Blank when the previous calendar month is missing."],
    ["Period return", "close_end / close_start - 1", "Start is the month-end close just before the window, so a 12M window covers 12 monthly returns."],
    ["Rolling 12-month return", "close_m / close_(m-12) - 1", "Needs the close exactly 12 calendar months earlier."],
    ["SMA 12 / SMA 24", "Mean of the last 12 / 24 monthly closes", "Needs 12 / 24 consecutive months. Computed on full history, then cropped to the window."],
    ["RSI 14, monthly", "100 - 100 / (1 + avg gain / avg loss)", "Wilder smoothing over 14 monthly price changes. First value at the 15th consecutive month. Restarts after a missing month."],
    ["Monthly volatility", "Sample st. dev. of monthly returns", "Minimum 6 monthly returns."],
    ["Annualized volatility", "Monthly volatility x sqrt(12)", "12 observations per year. No daily or trading-day factor is used anywhere."],
    ["Rolling 12-month volatility", "The above over the last 12 monthly returns", "Needs 12 consecutive months with at least 10 returns."],
    ["Maximum drawdown", "min(close_m / running peak close - 1)", "Monthly closes only, inside the window including its starting close."],
    ["Drawdown from record close", "close_m / highest close so far - 1", "Running peak over the whole dataset, not just the window."],
    ["Correlation", "Pearson, monthly returns", "Calendar months present in both files. Window value needs 6 pairs; rolling version uses 12 months, minimum 10 pairs."],
    ["Annualized return (CAGR)", "(close_end / close_start)^(12 / months) - 1", "Shown for spans of 12 months or more."],
    ["Sharpe ratio", "(mean monthly return - rf_m) / st. dev. x sqrt(12)", "rf_m = (1 + rf)^(1/12) - 1. Needs 12 monthly returns."],
    ["Sortino ratio", "(mean monthly return - rf_m) / downside deviation x sqrt(12)", "Downside deviation of returns below rf_m. Needs 12 monthly returns."],
    ["Calmar ratio", "CAGR / |maximum drawdown|", "Needs 12 months."],
    ["Calendar-year return", "December close / previous December close - 1", "Years without both December closes are shown as partial and labelled with their actual span."],
    ["Range levels", "Lowest low / highest high of the last 12 and 24 months", "Donchian extremes. Closes are used when the file has no high and low. Descriptive, not predictive."],
  ];
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <H>Data source and frequency</H>
        <P>All figures come from monthly CSV files: one record per calendar month with open, high, low, close, volume and month-end market capitalization. The dashboard opens with the two CoinMarketCap monthly exports supplied for this project, embedded unchanged, and you can replace them through Data sources. Currently loaded: {data ? data.source : "nothing"}.</P>
        <P>CoinMarketCap prices are volume-weighted aggregates across many exchanges, in USD, on UTC calendar months. They are not the prices of any single exchange.</P>
      </Card>
      <Table caption="Indicator definitions and calculation methods" csvName="pinkshazam-methodology-monthly.csv" rows={defs.map(([n, f, c]) => ({ n, f, c }))}
        cols={[{ label: "Indicator", key: "n", left: true }, { label: "Formula", key: "f", left: true, render: (r) => <span className="whitespace-normal block" style={{ minWidth: 220, color: C.slate }}>{r.f}</span> }, { label: "Conditions", key: "c", left: true, render: (r) => <span className="whitespace-normal block" style={{ minWidth: 280, color: C.muted }}>{r.c}</span> }]} />
      <Card className="p-5">
        <H>Risk-free rate assumption</H>
        <P>Sharpe and Sortino ratios subtract a risk-free rate that you set on the Risk &amp; performance page. It is currently {(rf * 100).toFixed(2)}% a year. The default of 0% is a simplifying assumption, not an observed interest rate, and with it the Sharpe ratio is simply average return divided by volatility. One constant rate is applied to every month in the window.</P>
      </Card>
      <Card className="p-5">
        <H>Analysis periods</H>
        <P>The 6M, 12M, 24M, 36M and 5Y filters select that many of the latest calendar months; ALL uses every month in the file. Returns are measured from the month-end close just before the window. Moving averages, RSI and rolling measures use months before the window whenever the dataset has them. The Risk page compares BTC and ETH only over the calendar months both files contain, and accepts a custom start and end month.</P>
      </Card>
      <Card className="p-5">
        <H>Data validation</H>
        <P>Each file is checked for monthly frequency: files with several rows per month, or rows several months apart, are rejected. Rows with an unreadable date or a missing close are dropped. Duplicate months keep the last row. Missing months are listed and never filled or interpolated; returns, averages and RSI do not bridge them. Where a record carries its own start and end time, the dashboard checks that it spans the full calendar month, and a final record that does not is excluded.</P>
      </Card>
      <Card className="p-5">
        <H>Limits of monthly sampling</H>
        <P>One observation per month hides everything in between. Drawdowns are measured between month-end closes, so the lows reached inside a month were deeper. Volatility from monthly returns is not the same number as volatility from daily returns. A 12-month window holds only 12 returns, so volatility, correlation and Sharpe ratios over short windows are imprecise. Monthly RSI and moving averages react slowly and are unsuitable for timing. Early records in a source's history can rest on thin trading and incomplete volume.</P>
      </Card>
      <Card className="p-5">
        <H>Historical analysis is not forecasting</H>
        <P>Everything here measures what already happened in the loaded sample. No model in this dashboard projects prices, tests a trading strategy or estimates future returns. Past cycles, averages and ranges do not establish what happens next. Nothing on this site is investment advice.</P>
      </Card>
    </div>
  );
}

/* ================================== Shell ================================== */
const NAV = [
  { id: "overview", label: "Market overview", icon: LayoutDashboard, group: "Analysis" },
  { id: "btc", label: "Bitcoin technicals", icon: Bitcoin, group: "Analysis" },
  { id: "eth", label: "Ethereum technicals", icon: Hexagon, group: "Analysis" },
  { id: "risk", label: "Risk & performance", icon: Shield, group: "Analysis" },
  { id: "research", label: "Research & insights", icon: FileText, group: "Analysis" },
  { id: "data", label: "Data sources", icon: Database, group: "Reference" },
  { id: "method", label: "Methodology", icon: BookOpen, group: "Reference" },
];
function SourceChip() {
  const { data, go } = useApp();
  const s = data && (data.btc.rows.length ? data.btc : data.eth);
  const last = s && s.rows.length ? s.rows[s.rows.length - 1].date : null;
  const providers = data ? [...new Set([data.btc, data.eth].filter((x) => x.rows.length).map((x) => x.provider))].join(" + ") : "No data loaded";
  const part = (k, v, cls = "inline-flex") => <span className={`${cls} items-baseline gap-1`} style={{ whiteSpace: "nowrap" }}><span style={{ color: C.faint }}>{k}</span> <span style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{v}</span></span>;
  return (
    <button type="button" onClick={() => go("data")} title="Open data sources" data-chip="source" className="ps-chip flex items-center gap-3 px-3 py-1 rounded-md text-xs text-left" style={{ border: `1px solid ${C.border}`, background: C.surface }}>
      <span style={{ width: 7, height: 7, borderRadius: 7, background: data ? C.pink : C.faint, display: "inline-block", flexShrink: 0 }} />
      {part("Source", providers)}
      {data && part("Frequency", "Monthly", "hidden sm:inline-flex")}
      {last && part("Data through", ymLabel(last))}
    </button>
  );
}
function Brand() {
  return (
    <div className="flex items-center gap-3">
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <rect width="28" height="28" rx="6" fill={C.raised} stroke={C.border} />
        <polyline points="5,19 10,13 14,16 19,8 23,11" fill="none" stroke={C.pink} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx="19" cy="8" r="2" fill={C.purple} />
      </svg>
      <div>
        <div className="text-sm font-semibold" style={{ color: C.text, letterSpacing: "-0.01em" }}>PinkShazam</div>
        <div className="text-xs" style={{ color: C.muted }}>Crypto Market Intelligence</div>
      </div>
    </div>
  );
}

function NavList({ section, go }: Props) {
  return (
    <nav aria-label="Sections" className="space-y-5">
      {["Analysis", "Reference"].map((g) => (
        <div key={g}>
          <div className="px-3 mb-1 text-xs" style={{ color: C.faint }}>{g}</div>
          {NAV.filter((n) => n.group === g).map((n) => {
            const on = n.id === section, Icon = n.icon;
            return (
              <button key={n.id} type="button" aria-current={on ? "page" : undefined} onClick={() => go(n.id)}
                className="ps-nav w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-left"
                style={{ color: on ? C.text : C.muted, background: on ? C.raised : "transparent", boxShadow: on ? `inset 2px 0 0 ${C.pink}` : "none", fontWeight: on ? 600 : 400 }}>
                <Icon size={16} style={{ color: on ? C.pink : C.faint }} />{n.label}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export default function PinkShazamDashboard() {
  const [boot] = useState(() => { try { return { data: loadBundled(), error: "" }; } catch (e) { return { data: null, error: "The bundled files could not be read: " + e.message }; } });
  const [data, setData] = useState(boot.data);
  const [error, setError] = useState(boot.error);
  const [section, setSection] = useState("overview");
  const [tf, setTf] = useState("5Y");
  const [rfText, setRfText] = useState("0");
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState(null);
  const [exp, setExp] = useState(null);
  const timer = useRef(null);
  const rfNum = parseFloat(rfText);
  const rf = Number.isFinite(rfNum) ? Math.min(Math.max(rfNum, 0), 25) / 100 : 0;

  const toast = useCallback((text, bad) => {
    setNote({ text, bad });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), 3500);
  }, []);
  const go = useCallback((id) => { setSection(id); setMenu(false); window.scrollTo(0, 0); }, []);
  const closeExport = useCallback(() => setExp(null), []);
  const restore = useCallback(() => {
    try { setData(loadBundled()); setError(""); } catch (e) { setError("The bundled files could not be read: " + e.message); }
  }, []);
  // Adds, replaces or removes one asset's uploaded monthly series.
  const applyCsv = useCallback((asset, series) => {
    setData((prev) => {
      const btc = asset === "BTC" ? series || emptySeries("BTC") : prev ? prev.btc : emptySeries("BTC");
      const eth = asset === "ETH" ? series || emptySeries("ETH") : prev ? prev.eth : emptySeries("ETH");
      return makeData(btc, eth);
    });
    setError("");
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const ctx: AppCtx = { data, error, tf, setTf, rf, rfText, setRfText, go, toast, applyCsv, restore, exp, openExport: setExp, closeExport };
  const current = NAV.find((n) => n.id === section);
  const needsData = !["data", "method"].includes(section);
  const showTf = needsData && section !== "risk";

  let body;
  if (needsData && !data) body = <NeedData />;
  else if (section === "overview") body = <Overview />;
  else if (section === "btc") body = <Technical asset="BTC" key="BTC" />;
  else if (section === "eth") body = <Technical asset="ETH" key="ETH" />;
  else if (section === "risk") body = <Risk />;
  else if (section === "research") body = <Research />;
  else if (section === "data") body = <DataSources />;
  else body = <Methodology />;

  return (
    <Ctx.Provider value={ctx}>
      <style>{`
        .ps-root button:focus-visible, .ps-root input:focus-visible, .ps-root select:focus-visible, .ps-root a:focus-visible { outline: 2px solid ${C.pink}; outline-offset: 2px; }
        .ps-btn:not(:disabled):hover { filter: brightness(1.15); }
        .ps-nav:hover { background: ${C.raised}; color: ${C.text}; }
        .ps-seg:not(:disabled):hover { color: ${C.text}; }
        .ps-icon:hover { color: ${C.text}; }
        .ps-chip:hover { border-color: ${C.faint} !important; }
        .ps-row:hover td { background: rgba(255,255,255,0.02); }
        .ps-root .recharts-surface { overflow: visible; }
      `}</style>
      <div className="ps-root min-h-screen flex" style={{ background: C.bg, color: C.text, fontFamily: FONT }}>
        <aside className="hidden lg:flex flex-col w-60 shrink-0 p-4 sticky top-0 h-screen" style={{ borderRight: `1px solid ${C.border}`, background: C.bg }}>
          <Brand />
          <div className="mt-8 flex-1 overflow-y-auto"><NavList section={section} go={go} /></div>
          <div className="text-xs pt-4" style={{ color: C.faint, borderTop: `1px solid ${C.border}`, lineHeight: 1.5 }}>Long-Term Market Research &amp; Data Analytics</div>
        </aside>
        {menu && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div className="w-64 p-4 h-full overflow-y-auto" style={{ background: C.bg, borderRight: `1px solid ${C.border}` }}>
              <div className="flex items-center justify-between"><Brand /><button type="button" aria-label="Close menu" onClick={() => setMenu(false)} className="p-2" style={{ color: C.muted }}><X size={18} /></button></div>
              <div className="mt-8"><NavList section={section} go={go} /></div>
              <div className="text-xs mt-8 pt-4" style={{ color: C.faint, borderTop: `1px solid ${C.border}` }}>Long-Term Market Research &amp; Data Analytics</div>
            </div>
            <button type="button" aria-label="Close menu" className="flex-1" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => setMenu(false)} />
          </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="sticky top-0 z-30 px-4 md:px-6 py-3 flex flex-wrap items-center justify-between gap-3" style={{ background: "rgba(11,13,19,0.92)", borderBottom: `1px solid ${C.border}`, backdropFilter: "blur(6px)" }}>
            <div className="flex items-center gap-3 min-w-0">
              <button type="button" aria-label="Open menu" onClick={() => setMenu(true)} className="lg:hidden p-2 rounded-md" style={{ border: `1px solid ${C.border}`, color: C.text }}><Menu size={16} /></button>
              <div className="min-w-0">
                <h1 className="text-base md:text-lg font-semibold truncate" style={{ letterSpacing: "-0.01em" }}>{current.label}</h1>
                <div className="text-xs lg:hidden" style={{ color: C.muted }}>PinkShazam | Crypto Market Intelligence</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <SourceChip />
              {showTf && <Seg label="Timeframe" options={TIMEFRAMES} value={tf} onChange={setTf} />}
            </div>
          </header>
          <main className="flex-1 px-4 md:px-6 py-5">{body}</main>
          <footer className="px-4 md:px-6 py-4 text-xs flex flex-wrap justify-between gap-2" style={{ borderTop: `1px solid ${C.border}`, color: C.faint }}>
            <span>Research &amp; Data Visualization by PinkShazam</span>
            <span>{data ? `Monthly data: ${data.source}. ` : ""}Historical analysis only. Not investment advice.</span>
          </footer>
        </div>
        <ExportDialog />
        {note && (
          <div role="status" className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded-md text-sm" style={{ background: C.raised, border: `1px solid ${note.bad ? C.down : C.border}`, color: C.text, boxShadow: "0 8px 24px rgba(0,0,0,0.45)" }}>{note.text}</div>
        )}
      </div>
    </Ctx.Provider>
  );
}

/* ============================== bundled data ==============================
   The two CoinMarketCap monthly exports in src/data, imported as raw text and
   parsed by the same code path as an uploaded file. To update the dashboard,
   replace those files with newer monthly exports (and adjust the names here).
   ========================================================================== */
const BUNDLED: Record<AssetId, { fileName: string; csv: string }> = {
  BTC: { fileName: "Bitcoin_10_11_2024-10_11_2026_historical_data_coinmarketcap.csv", csv: btcCsv },
  ETH: { fileName: "Ethereum_10_11_2024-10_11_2026_historical_data_coinmarketcap.csv", csv: ethCsv },
};
