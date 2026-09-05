import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/**
 * Heron Tennis Summer Ladder 2026 — plain React + Supabase (shared realtime).
 *
 * Multi-ladder edition:
 * - Men's + Women's ladders in one app Premier too?
 * - Top toggle switches between ladders
 * - Each ladder has fully separate players, matches, and playerCount
 * - Shared cloud sync via Supabase
 * - Admin writes go through /api/admin with PIN
 * - Mobile-friendly browser layout while keeping desktop layout intact
 */

const DEFAULT_PLAYER_COUNT = 40;
const LEGACY_SEASON_ID = "may-july-2026";
const CAPACITY = 60;
const DIVISIONS = [
  { key: "mens", label: "Men's" },
  { key: "womens", label: "Women's" },
  { key: "premier", label: "Premier"},
];


const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

function uid() {
  return Math.random().toString(36).slice(2, 9) + "_" + Date.now().toString(36);
}

function asNumber(x, fallback) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function clampMin0(n) {
  return Math.max(0, asNumber(n, 0));
}

function formatDateISO(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function seasonDropPeriods(season) {
  if (!season?.start_date || !season?.end_date) return [];
  const start = new Date(`${season.start_date}T12:00:00`);
  const end = new Date(`${season.end_date}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];

  const periods = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1, 12);
  while (cursor <= end && periods.length < 12) {
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 12);
    const periodStart = monthStart < start ? start : monthStart;
    const periodEnd = monthEnd > end ? end : monthEnd;
    const label = `${periodStart.toLocaleDateString("en-GB", { day: "numeric", month: "long" })} – ${periodEnd.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`;
    periods.push({
      key: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`,
      label,
      start: formatDateISO(periodStart),
      end: formatDateISO(periodEnd),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return periods;
}

function monthKeyFromDateISO(dateISO) {
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getMonth();
  if (m === 3) return "apr";
  if (m === 4) return "may";
  if (m === 5) return "jun";
  if (m === 6) return "jul";
  if (m === 7) return "aug";
  if (m === 8) return "sep";
  if (m === 9) return "oct";
  if (m === 10) return "nov";
  return null;
}

function createEmptyPlayer(position, division) {
  return {
    pid: `${division}_p${position}`,
    division,
    position,
    name: "",
    matchesPlayed: 0,
    matchesWon: 0,
    setsWon: 0,
    setsLost: 0,
    gamesWon: 0,
    gamesLost: 0,
    apr: 0,
    may: 0,
    jun: 0,
    jul: 0,
    aug: 0,
    sep: 0,
    oct: 0,
    nov: 0,
    withdrawn: false,
  };
}

function createDivisionState(division) {
  return {
    playerCount: DEFAULT_PLAYER_COUNT,
    players: Array.from({ length: CAPACITY }, (_, i) => createEmptyPlayer(i + 1, division)),
    matches: [],
  };
}

function defaultState() {
  return {
    mens: createDivisionState("mens"),
    womens: createDivisionState("womens"),
  };
}

function parseScore(scoreStr) {
  const raw = String(scoreStr || "").trim();
  if (!raw) return { valid: false, sets: [], isMTB: false, message: "Please enter a score (e.g. 6-4 6-3)." };

  // Accept human-friendly formats like:
  // 6-4 6-3
  // 6-4, 6-3
  // 6-4,3-6,10-8
  // 6:4 3:6 10:8
  const matches = raw.match(/\d+\s*[-:]\s*\d+/g) || [];
  if (matches.length < 2) {
    return { valid: false, sets: [], isMTB: false, message: "Enter at least 2 sets (e.g. 6-4 6-3)." };
  }

  const sets = [];
  let isMTB = false;

  for (const part of matches) {
    const bits = part.split(/[-:]/);
    if (bits.length !== 2) return { valid: false, sets: [], isMTB: false, message: `Couldn't read set: "${part}"` };

    const p1 = asNumber(bits[0].trim(), NaN);
    const p2 = asNumber(bits[1].trim(), NaN);
    if (!Number.isFinite(p1) || !Number.isFinite(p2)) {
      return { valid: false, sets: [], isMTB: false, message: `Couldn't read set: "${part}"` };
    }

    if (p1 >= 10 || p2 >= 10) isMTB = true;
    sets.push({ p1, p2 });
  }

  return { valid: true, sets, isMTB };
}

function isMatchTieBreakSet(set) {
  return Number(set?.p1 || 0) >= 10 || Number(set?.p2 || 0) >= 10;
}

function formatScore(score) {
  if (String(score || "").startsWith("ADMIN:")) return String(score || "");
  const parsed = parseScore(score);
  return parsed.isMTB ? `${score} (MTB)` : score;
}

function formatScoreForPlayer(score, isChallenger) {
  if (String(score || "").startsWith("ADMIN:")) return String(score || "");
  if (isChallenger) return formatScore(score);

  const parsed = parseScore(score);
  if (!parsed.valid) return formatScore(score);

  const flipped = parsed.sets.map((s) => `${s.p2}-${s.p1}`).join(" ");
  return parsed.isMTB ? `${flipped} (MTB)` : flipped;
}

function validateSets(sets) {
  if (!Array.isArray(sets) || sets.length < 2) {
    return { ok: false, message: "Enter at least 2 sets (e.g. 6-4 6-3)." };
  }

  let p1Sets = 0;
  let p2Sets = 0;

  for (const s of sets) {
    const a = asNumber(s.p1, -1);
    const b = asNumber(s.p2, -1);
    if (a < 0 || b < 0) return { ok: false, message: "Scores must be non-negative numbers." };
    if (a === b) return { ok: false, message: "A set can't be tied." };

    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    const diff = hi - lo;

    if (hi >= 10) {
      if (diff < 2) return { ok: false, message: "Match tie-break must be won by 2 points." };
    } else {
      const ok6 = hi === 6 && lo <= 4;
      const ok75 = hi === 7 && lo === 5;
      const ok76 = hi === 7 && lo === 6;
      if (!(ok6 || ok75 || ok76)) {
        return { ok: false, message: "Impossible set score. Use 6-x, 7-5, 7-6, or match tie-break 10+." };
      }
    }

    if (a > b) p1Sets += 1;
    else p2Sets += 1;
  }

  if (p1Sets === p2Sets) {
    return { ok: false, message: "Match can't end tied on sets. Add a deciding set / match tie-break." };
  }

  return { ok: true, message: "" };
}

function computeFromSets(sets) {
  let p1Sets = 0,
    p2Sets = 0,
    p1Games = 0,
    p2Games = 0;

  for (const s of sets) {
    if (s.p1 > s.p2) p1Sets += 1;
    else if (s.p2 > s.p1) p2Sets += 1;

    // Match tie-breaks (10-x or higher) count as 1 game to the winner,
    // not 10+ games in the game totals.
    if (isMatchTieBreakSet(s)) {
      if (s.p1 > s.p2) p1Games += 1;
      else if (s.p2 > s.p1) p2Games += 1;
    } else {
      p1Games += s.p1;
      p2Games += s.p2;
    }
  }

  return { p1Sets, p2Sets, p1Games, p2Games };
}


function seasonMonthColumns(season) {
  if (!season?.start_date || !season?.end_date) return [
    { key: "apr", label: "Apr Matches" }, { key: "may", label: "May Matches" },
    { key: "jun", label: "Jun Matches" }, { key: "jul", label: "Jul Matches" },
  ];
  const start = new Date(`${season.start_date}T00:00:00`);
  const end = new Date(`${season.end_date}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const out = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end && out.length < 12) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,"0")}`;
    out.push({ key, label: `${cursor.toLocaleDateString("en-GB", { month: "short" })} Matches`, monthIndex: cursor.getMonth(), year: cursor.getFullYear() });
    cursor.setMonth(cursor.getMonth()+1);
  }
  return out;
}

function reconstructInitialPlayers(players, matches) {
  let initial = players.map((p) => ({ ...p }));
  const ordered = [...matches]
    .filter((m) => m.ladderMoveApplied)
    .sort((a,b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  for (const m of ordered) initial = reverseLadderMove(initial, m.challengerPid, m.challengerStartPos, m.opponentStartPos);
  return initial;
}

function computeNumberOneStats(players, matches, season, nowMs = Date.now()) {
  const result = new Map();
  const ensure = (pid) => { if (!result.has(pid)) result.set(pid, { daysAtOne: 0, numberOneDefences: 0 }); return result.get(pid); };
  if (!season?.start_date || !season?.end_date) return result;
  const start = new Date(`${season.start_date}T00:00:00`);
  const end = new Date(`${season.end_date}T23:59:59`);
  const stop = new Date(Math.min(end.getTime(), nowMs));
  if (Number.isNaN(start.getTime()) || stop < start) return result;
  const initial = reconstructInitialPlayers(players, matches);
  let leaderPid = initial.find((p) => p.position === 1)?.pid || null;
  let cursor = start;
  const ordered = [...matches].filter((m) => !String(m.score||"").startsWith("ADMIN:")).sort((a,b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  for (const m of ordered) {
    const when = new Date(`${m.date}T12:00:00`);
    if (Number.isNaN(when.getTime()) || when < start || when > stop) continue;
    if (leaderPid) ensure(leaderPid).daysAtOne += Math.max(0, (when - cursor) / 86400000);
    if (m.opponentStartPos === 1 && m.opponentPid === leaderPid && m.winnerId === "p2") ensure(leaderPid).numberOneDefences += 1;
    if (m.ladderMoveApplied && m.opponentStartPos === 1 && m.winnerId === "p1") leaderPid = m.challengerPid;
    cursor = when;
  }
  if (leaderPid) ensure(leaderPid).daysAtOne += Math.max(0, (stop - cursor) / 86400000);
  for (const value of result.values()) value.daysAtOne = Math.round(value.daysAtOne);
  return result;
}

function formatProfileDate(dateISO) {
  if (!dateISO) return "—";
  const d = new Date(`${dateISO}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(dateISO);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function scoreDetailsForPlayer(score, isChallenger) {
  const parsed = parseScore(score);
  if (!parsed.valid) return { totalGames: 0, bagelsWon: 0 };
  let totalGames = 0;
  let bagelsWon = 0;
  for (const set of parsed.sets) {
    totalGames += isMatchTieBreakSet(set) ? 1 : set.p1 + set.p2;
    const own = isChallenger ? set.p1 : set.p2;
    const opp = isChallenger ? set.p2 : set.p1;
    if (own === 6 && opp === 0) bagelsWon += 1;
  }
  return { totalGames, bagelsWon };
}

function chooseBiggestWin(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate.gap !== current.gap) return candidate.gap > current.gap ? candidate : current;
  if (candidate.to !== current.to) return candidate.to < current.to ? candidate : current;
  return String(candidate.date || "") > String(current.date || "") ? candidate : current;
}

function summarizeMatchups(matchRows, playerPid) {
  const map = new Map();
  let biggestUpset = null;
  for (const m of matchRows) {
    if (String(m.score||"").startsWith("ADMIN:")) continue;
    const involved = m.challengerPid === playerPid || m.opponentPid === playerPid;
    if (!involved) continue;
    const isChallenger = m.challengerPid === playerPid;
    const didWin = (isChallenger && m.winnerId === "p1") || (!isChallenger && m.winnerId === "p2");
    const opponentName = isChallenger ? m.opponentName : m.challengerName;
    const key = String(opponentName||"Unknown").trim().toLowerCase();
    const row = map.get(key) || { name: opponentName || "Unknown", played: 0, wins: 0, losses: 0 };
    row.played += 1; didWin ? row.wins++ : row.losses++; map.set(key,row);
    if (didWin && isChallenger) {
      const gap = Math.max(0, asNumber(m.challengerStartPos,0) - asNumber(m.opponentStartPos,0));
      biggestUpset = chooseBiggestWin(biggestUpset, { gap, opponent: opponentName || "Unknown", score: m.score, date: m.date, from: asNumber(m.challengerStartPos, 0), to: asNumber(m.opponentStartPos, 0) });
    }
  }
  const rows=[...map.values()].filter(x=>x.played>0).map(x=>({...x, winPct: Math.round((x.wins/x.played)*100)}));
  const best=[...rows].sort((a,b)=>b.winPct-a.winPct || b.played-a.played || b.wins-a.wins)[0] || null;
  const worst=[...rows].sort((a,b)=>a.winPct-b.winPct || b.played-a.played || b.losses-a.losses)[0] || null;
  return { biggestUpset, best, worst };
}

const COLS = [
  { key: "position", label: "Pos" },
  { key: "name", label: "Name" },
  { key: "ladderProgress", label: "Ladder Progress" },
  { key: "matchesPlayed", label: "Matches Played" },
  { key: "matchesWon", label: "Matches Won" },
  { key: "setsWon", label: "Sets Won" },
  { key: "setsLost", label: "Sets Lost" },
  { key: "setDiff", label: "Set Diff" },
  { key: "gamesWon", label: "Games Won" },
  { key: "gamesLost", label: "Games Lost" },
  { key: "gameDiff", label: "Game Diff" },
];

function valueForColumn(p, colKey) {
  if (colKey === "name") return String(p.name || "").toLowerCase();
  return p[colKey] ?? 0;
}

function compareByColumn(a, b, colKey, dir) {
  const av = valueForColumn(a, colKey);
  const bv = valueForColumn(b, colKey);
  const mul = dir === "asc" ? 1 : -1;

  if (typeof av === "number" && typeof bv === "number") {
    if (av !== bv) return (av - bv) * mul;
    return (a.position - b.position) * mul;
  }

  const as = String(av);
  const bs = String(bv);
  if (as !== bs) return as.localeCompare(bs) * mul;
  return (a.position - b.position) * mul;
}

function applyLadderMove(players, challengerPid, opponentPos) {
  const challenger = players.find((p) => p.pid === challengerPid);
  if (!challenger) return { players, applied: false };

  const challengerStartPos = challenger.position;
  if (challengerStartPos <= opponentPos) return { players, applied: false };

  const moved = players.map((p) => ({ ...p }));

  for (const p of moved) {
    if (p.pid === challengerPid) continue;
    if (p.position >= opponentPos && p.position < challengerStartPos) p.position += 1;
  }

  const ch = moved.find((p) => p.pid === challengerPid);
  if (ch) ch.position = opponentPos;

  return { players: moved, applied: true };
}

function reverseLadderMove(players, challengerPid, challengerStartPos, opponentStartPos) {
  const ch = players.find((p) => p.pid === challengerPid);
  if (!ch) return players;

  const next = players.map((p) => ({ ...p }));

  for (const p of next) {
    if (p.pid === challengerPid) continue;
    if (p.position > opponentStartPos && p.position <= challengerStartPos) p.position -= 1;
  }

  const c = next.find((p) => p.pid === challengerPid);
  if (c) c.position = challengerStartPos;

  return next;
}

function ladderRowStyle(position) {
  if (position === 1) return { background: "rgba(255, 215, 0, 0.25)" };
  if (position === 2) return { background: "rgba(192, 192, 192, 0.25)" };
  if (position === 3) return { background: "rgba(205, 127, 50, 0.22)" };
  return undefined;
}

function Modal({ open, title, children, actions, onClose, mobileFull = false, className = "" }) {
  if (!open) return null;
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className={["modalCard", mobileFull ? "mobileFull" : "", className].filter(Boolean).join(" ")}>
        <div className="modalHeader">
          <div className="modalTitle">{title}</div>
          <button className="iconBtn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modalBody">{children}</div>
        {actions ? <div className="modalFooter">{actions}</div> : null}
      </div>
    </div>
  );
}

function StatCell({ locked, value, onChange }) {
  if (locked) return <div className="numText">{value}</div>;
  return <input className="numInput" type="number" min={0} value={value} onChange={(e) => onChange(asNumber(e.target.value, 0))} />;
}

function LeaderCard({ medal, p, rank, onClick, form = [] }) {
  if (!p) return <div className="leaderCard empty">—</div>;
  return (
    <button type="button" className={`leaderCard podium rank${rank}`} onClick={onClick}>
      <div className="leaderGlow" />
      <div className="leaderMedal">{medal}</div>
      <div className="leaderName" title={p.name}>
        {p.name}
      </div>
      <div className="leaderSub" style={{ marginTop: 4 }}>
        Pos #{p.position}
      </div>
      <div className="leaderStats">
        <div>W: {p.matchesWon}</div>
        <div>
          SD: {p.setDiff} • GD: {p.gameDiff}
        </div>
      </div>
      <div className="formStrip">{form.map((x, i) => <span key={i} className={x === "W" ? "formWin" : "formLoss"}>{x}</span>)}</div>
    </button>
  );
}

function MobileSummary({ divisionLabel, playerCount, totalMatches, top3 }) {
  return (
    <div className="mobileSummary">
      <div className="summaryPill">
        <div className="summaryLabel">Ladder</div>
        <div className="summaryValue">{divisionLabel}</div>
      </div>
      <div className="summaryPill">
        <div className="summaryLabel">Players</div>
        <div className="summaryValue">{playerCount}</div>
      </div>
      <div className="summaryPill">
        <div className="summaryLabel">Matches</div>
        <div className="summaryValue">{totalMatches}</div>
      </div>
      <div className="summaryPill wide">
        <div className="summaryLabel">Top 3</div>
        <div className="summaryValue small">
          {top3.length === 0 ? "—" : top3.map((p, i) => `${i + 1}. ${p.name || "—"}`).join(" • ")}
        </div>
      </div>
    </div>
  );
}


function AnalyticsPanel({ analytics, divisionLabel, seasonLabel }) {
  const maxMonth = Math.max(1, ...analytics.monthly.map((x) => x.matches));
  const [playerSort, setPlayerSort] = useState({ key: "played", dir: "desc" });
  const [h2hSort, setH2hSort] = useState({ key: "meetings", dir: "desc" });

  function changeSort(setter, key, defaultDir = "desc") {
    setter((prev) => prev.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: defaultDir });
  }

  function textCompare(a, b) {
    return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });
  }

  function playerValue(row, key) {
    if (key === "form") return row.form.reduce((score, result, index) => score + (result === "W" ? (5 - index) : 0), 0);
    return row[key];
  }

  const sortedPlayers = useMemo(() => {
    const rows = [...analytics.playerRows];
    const { key, dir } = playerSort;
    const mul = dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const av = playerValue(a, key);
      const bv = playerValue(b, key);
      let result = 0;
      if (typeof av === "number" && typeof bv === "number") result = av - bv;
      else result = textCompare(av, bv);
      if (result !== 0) return result * mul;

      // Sensible tie-breaks: identical percentages favour the larger sample,
      // then total wins, then ladder position.
      if (key === "winPct" && a.played !== b.played) return (a.played - b.played) * mul;
      if (key !== "wins" && a.wins !== b.wins) return (a.wins - b.wins) * mul;
      if (a.played !== b.played) return (a.played - b.played) * mul;
      return a.position - b.position;
    });
    return rows;
  }, [analytics.playerRows, playerSort]);

  function h2hValue(row, key) {
    if (key === "players") return `${row.playerAName} ${row.playerBName}`;
    if (key === "record") return Math.max(row.playerAWins, row.playerBWins) / Math.max(1, row.meetings);
    if (key === "latest") return row.latestDate || "";
    return row[key];
  }

  const sortedHeadToHead = useMemo(() => {
    const rows = [...analytics.headToHead];
    const { key, dir } = h2hSort;
    const mul = dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const av = h2hValue(a, key);
      const bv = h2hValue(b, key);
      let result = 0;
      if (typeof av === "number" && typeof bv === "number") result = av - bv;
      else result = textCompare(av, bv);
      if (result !== 0) return result * mul;
      if (a.meetings !== b.meetings) return (a.meetings - b.meetings) * mul;
      return textCompare(`${a.playerAName} ${a.playerBName}`, `${b.playerAName} ${b.playerBName}`);
    });
    return rows;
  }, [analytics.headToHead, h2hSort]);

  function SortHeader({ label, sortState, sortKey, onSort, defaultDir = "desc" }) {
    const active = sortState.key === sortKey;
    return (
      <th>
        <button type="button" className="thBtn analyticsSortBtn" onClick={() => onSort(sortKey, defaultDir)}>
          {label}{active ? (sortState.dir === "asc" ? " ▲" : " ▼") : ""}
        </button>
      </th>
    );
  }

  return (
    <div className="analyticsPanel">
      <div className="analyticsHeading">
        <div>
          <div className="cardTitle">Analytics</div>
          <div className="hint">{seasonLabel} • {divisionLabel} • Real matches only (admin actions excluded)</div>
        </div>
        <div className="analyticsBadge">{analytics.totalMatches} completed</div>
      </div>

      <div className="analyticsKpis">
        <div className="analyticsKpi"><div className="analyticsKpiLabel">Active players</div><div className="analyticsKpiValue">{analytics.activePlayers}</div></div>
        <div className="analyticsKpi"><div className="analyticsKpiLabel">Matches played</div><div className="analyticsKpiValue">{analytics.totalMatches}</div></div>
        <div className="analyticsKpi"><div className="analyticsKpiLabel">Deciding matches</div><div className="analyticsKpiValue">{analytics.deciders}</div><div className="analyticsKpiSub">{analytics.deciderRate}% of matches</div></div>
        <div className="analyticsKpi"><div className="analyticsKpiLabel">Challenge wins</div><div className="analyticsKpiValue">{analytics.challengerWins}</div><div className="analyticsKpiSub">{analytics.challengeWinRate}% success rate</div></div>
      </div>

      <div className="analyticsGrid">
        <div className="analyticsBox">
          <div className="analyticsBoxTitle">Monthly activity</div>
          <div className="barChart">
            {analytics.monthly.map((item) => (
              <div className="barRow" key={item.key}>
                <div className="barLabel">{item.label}</div>
                <div className="barTrack"><div className="barFill" style={{ width: `${Math.max(item.matches ? 8 : 0, (item.matches / maxMonth) * 100)}%` }} /></div>
                <div className="barValue">{item.matches}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="analyticsBox analyticsTableBox">
        <div className="analyticsBoxTitle">Player performance <span className="analyticsSortHint">Click any heading to sort</span></div>
        {analytics.playerRows.length === 0 ? <div className="hint analyticsEmpty">Add completed matches to populate analytics.</div> : (
          <div className="tableWrap">
            <table className="table analyticsTable">
              <thead><tr>
                <SortHeader label="Player" sortState={playerSort} sortKey="name" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} defaultDir="asc" />
                <SortHeader label="P" sortState={playerSort} sortKey="played" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} />
                <SortHeader label="W" sortState={playerSort} sortKey="wins" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} />
                <SortHeader label="Win %" sortState={playerSort} sortKey="winPct" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} />
                <SortHeader label="Successful challenges" sortState={playerSort} sortKey="successfulChallenges" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} />
                <SortHeader label="Successful defences" sortState={playerSort} sortKey="successfulDefences" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} />
                <SortHeader label="Set diff" sortState={playerSort} sortKey="setDiff" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} />
                <SortHeader label="Game diff" sortState={playerSort} sortKey="gameDiff" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} />
                <SortHeader label="Current form" sortState={playerSort} sortKey="form" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} />
                <SortHeader label="Best streak" sortState={playerSort} sortKey="bestStreak" onSort={(key, dir) => changeSort(setPlayerSort, key, dir)} />
              </tr></thead>
              <tbody>
                {sortedPlayers.map((p) => (
                  <tr key={p.pid}>
                    <td><strong>{p.name}</strong><div className="analyticsPosition">Current #{p.position}</div></td>
                    <td>{p.played}</td><td>{p.wins}</td><td>{p.winPct}%</td><td>{p.successfulChallenges}</td><td>{p.successfulDefences}</td><td>{p.setDiff > 0 ? "+" : ""}{p.setDiff}</td><td>{p.gameDiff > 0 ? "+" : ""}{p.gameDiff}</td>
                    <td><div className="formStrip analyticsForm">{p.form.map((x, i) => <span key={i} className={x === "W" ? "formWin" : "formLoss"}>{x}</span>)}</div></td>
                    <td>{p.bestStreak}</td>
                    <td>{p.daysAtOne}</td><td>{p.numberOneDefences}</td>
                    <td>{p.biggestUpset ? `#${p.biggestUpset.from} → #${p.biggestUpset.to} vs ${p.biggestUpset.opponent}` : "—"}</td>
                    <td>{p.bestVs ? `${p.bestVs.name} (${p.bestVs.wins}–${p.bestVs.losses})` : "—"}</td>
                    <td>{p.worstVs ? `${p.worstVs.name} (${p.worstVs.wins}–${p.worstVs.losses})` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="analyticsBox analyticsTableBox">
        <div className="analyticsBoxTitle">Head to head <span className="analyticsSortHint">Click any heading to sort</span></div>
        {analytics.headToHead.length === 0 ? <div className="hint analyticsEmpty">Head-to-head records appear once two players have met.</div> : (
          <div className="tableWrap">
            <table className="table analyticsTable h2hTable">
              <thead><tr>
                <SortHeader label="Players" sortState={h2hSort} sortKey="players" onSort={(key, dir) => changeSort(setH2hSort, key, dir)} defaultDir="asc" />
                <SortHeader label="Meetings" sortState={h2hSort} sortKey="meetings" onSort={(key, dir) => changeSort(setH2hSort, key, dir)} />
                <SortHeader label="Record" sortState={h2hSort} sortKey="record" onSort={(key, dir) => changeSort(setH2hSort, key, dir)} />
                <SortHeader label="Leader" sortState={h2hSort} sortKey="leader" onSort={(key, dir) => changeSort(setH2hSort, key, dir)} defaultDir="asc" />
                <SortHeader label="Latest result" sortState={h2hSort} sortKey="latest" onSort={(key, dir) => changeSort(setH2hSort, key, dir)} />
              </tr></thead>
              <tbody>
                {sortedHeadToHead.map((row) => (
                  <tr key={row.key}>
                    <td><strong>{row.playerAName}</strong> vs <strong>{row.playerBName}</strong></td>
                    <td>{row.meetings}</td>
                    <td>{row.playerAWins}-{row.playerBWins}</td>
                    <td>{row.leader}</td>
                    <td>{row.latestWinner} beat {row.latestLoser} {row.latestScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

async function fetchSeasonMeta() {
  if (!supabase) throw new Error("Supabase client not configured.");
  const [seasonRes, settingRes] = await Promise.all([
    supabase.from("seasons").select("*").order("start_date", { ascending: false }),
    supabase.from("settings").select("*").in("key", ["default_public_season", "default_public_division"]),
  ]);
  if (seasonRes.error) throw new Error(seasonRes.error.message);
  if (settingRes.error) throw new Error(settingRes.error.message);
  const settings = Object.fromEntries((settingRes.data || []).map((x) => [x.key, x.value]));
  return {
    seasons: seasonRes.data || [],
    defaultSeasonId: String(settings.default_public_season || LEGACY_SEASON_ID),
    defaultDivision: settings.default_public_division === "womens" ? "womens" : "mens",
  };
}

async function fetchCloudState(seasonId) {
  if (!supabase) throw new Error("Supabase client not configured. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  const sid = String(seasonId || LEGACY_SEASON_ID);
  const [pRes, mRes, sRes] = await Promise.all([
    supabase.from("players").select("*").eq("season_id", sid).order("division", { ascending: true }).order("position", { ascending: true }),
    supabase.from("matches").select("*").eq("season_id", sid).order("created_at", { ascending: false }),
    supabase.from("settings").select("*").in("key", [`playerCount_${sid}_mens`, `playerCount_${sid}_womens`]),
  ]);
  if (pRes.error) throw new Error(pRes.error.message);
  if (mRes.error) throw new Error(mRes.error.message);
  if (sRes.error) throw new Error(sRes.error.message);
  const state = defaultState();
  for (const division of ["mens", "womens"]) {
    const rows = (pRes.data || []).filter((r) => String(r.division || "mens") === division);
    const byPos = new Map(rows.map((row) => [Number(row.position), row]));
    const players = [];
    for (let pos = 1; pos <= CAPACITY; pos++) {
      const row = byPos.get(pos);
      if (!row) { players.push(createEmptyPlayer(pos, division)); continue; }
      players.push({
        ...createEmptyPlayer(pos, division), pid: String(row.pid ?? `${division}_p${pos}`), division, position: pos,
        name: String(row.name || ""), matchesPlayed: asNumber(row.matches_played, 0), matchesWon: asNumber(row.matches_won, 0),
        setsWon: asNumber(row.sets_won, 0), setsLost: asNumber(row.sets_lost, 0), gamesWon: asNumber(row.games_won, 0), gamesLost: asNumber(row.games_lost, 0),
        apr: asNumber(row.apr, 0), may: asNumber(row.may, 0), jun: asNumber(row.jun, 0), jul: asNumber(row.jul, 0), aug: asNumber(row.aug, 0),
        withdrawn: Boolean(row.withdrawn || String(row.name || "").startsWith("W - ")),
      });
    }
    const settingsRow = (sRes.data || []).find((x) => x.key === `playerCount_${sid}_${division}`);
    state[division] = {
      playerCount: clamp(asNumber(settingsRow?.value ?? DEFAULT_PLAYER_COUNT, DEFAULT_PLAYER_COUNT), 2, CAPACITY), players,
      matches: (mRes.data || []).filter((m) => String(m.division || "mens") === division).map((row) => ({
        id: String(row.id), division, date: String(row.date || ""), positionPlayedFor: asNumber(row.position_played_for, 1),
        challengerPid: String(row.challenger_pid || ""), opponentPid: String(row.opponent_pid || ""),
        winnerId: row.winner_id === "p1" || row.winner_id === "p2" ? row.winner_id : "p2", score: String(row.score || ""), surface: String(row.surface || ""),
        challengerName: String(row.challenger_name || ""), opponentName: String(row.opponent_name || ""), winnerNameSnapshot: String(row.winner_name || ""),
        challengerStartPos: asNumber(row.challenger_start_pos, 0), opponentStartPos: asNumber(row.opponent_start_pos, 0), ladderMoveApplied: Boolean(row.ladder_move_applied),
      })),
    };
  }
  return state;
}


async function fetchLifetimeStats(playerName, division, seasonRows = []) {
  if (!supabase) throw new Error("Supabase client not configured.");
  const target = String(playerName || "").trim().toLowerCase();
  if (!target) throw new Error("Player name is missing.");

  const [matchRes, playerRes] = await Promise.all([
    supabase.from("matches").select("*").eq("division", division).order("date", { ascending: true }).order("created_at", { ascending: true }),
    supabase.from("players").select("season_id,pid,name,position,withdrawn").eq("division", division),
  ]);
  if (matchRes.error) throw new Error(matchRes.error.message);
  if (playerRes.error) throw new Error(playerRes.error.message);

  const seasonById = new Map((seasonRows || []).map((x) => [String(x.id), x]));
  const sameName = (value) => String(value || "").trim().toLowerCase() === target;
  const realMatches = (matchRes.data || []).filter((m) => !String(m.score || "").startsWith("ADMIN:"));
  const careerMatches = realMatches.filter((m) => sameName(m.challenger_name) || sameName(m.opponent_name));

  let wins = 0;
  let successfulChallenges = 0;
  let successfulDefences = 0;
  let currentStreak = 0;
  let bestStreak = 0;
  let setsWon = 0;
  let setsLost = 0;
  let gamesWon = 0;
  let gamesLost = 0;
  let biggestUpset = null;
  let worstDefeat = null;
  let longestMatch = null;
  let bagelSetsWon = 0;
  let challengeStreak = 0;
  let bestChallengeStreak = 0;
  const observedPositions = [];
  const opponentMap = new Map();
  const seasonMap = new Map();

  const normalized = careerMatches.map((m) => {
    const isChallenger = sameName(m.challenger_name);
    const didWin = (isChallenger && m.winner_id === "p1") || (!isChallenger && m.winner_id === "p2");
    const opponentName = String(isChallenger ? m.opponent_name : m.challenger_name).trim() || "Unknown";
    const sid = String(m.season_id || "");
    const season = seasonById.get(sid);
    const ownStart = isChallenger ? asNumber(m.challenger_start_pos, 0) : asNumber(m.opponent_start_pos, 0);
    if (ownStart > 0) observedPositions.push(ownStart);
    if (didWin && isChallenger) {
      const gap = Math.max(0, asNumber(m.challenger_start_pos, 0) - asNumber(m.opponent_start_pos, 0));
      biggestUpset = chooseBiggestWin(biggestUpset, { gap, opponent: opponentName, score: String(m.score || ""), date: String(m.date || ""), from: asNumber(m.challenger_start_pos, 0), to: asNumber(m.opponent_start_pos, 0), seasonId: sid, seasonName: season?.name || sid || "Unknown ladder season" });
    }
    if (!didWin && !isChallenger) {
      const gap = Math.max(0, asNumber(m.challenger_start_pos, 0) - asNumber(m.opponent_start_pos, 0));
      const candidate = { gap, opponent: opponentName, score: String(m.score || ""), date: String(m.date || ""), from: asNumber(m.opponent_start_pos, 0), challengerFrom: asNumber(m.challenger_start_pos, 0), seasonName: season?.name || sid || "Unknown ladder season" };
      if (!worstDefeat || gap > worstDefeat.gap || (gap === worstDefeat.gap && candidate.from < worstDefeat.from)) worstDefeat = candidate;
    }
    const parsed = parseScore(String(m.score || ""));
    let ownSets = 0, oppSets = 0, ownGames = 0, oppGames = 0;
    if (parsed.valid) {
      const computed = computeFromSets(parsed.sets);
      ownSets = isChallenger ? computed.p1Sets : computed.p2Sets;
      oppSets = isChallenger ? computed.p2Sets : computed.p1Sets;
      ownGames = isChallenger ? computed.p1Games : computed.p2Games;
      oppGames = isChallenger ? computed.p2Games : computed.p1Games;
    }
    const scoreInfo = scoreDetailsForPlayer(String(m.score || ""), isChallenger);
    bagelSetsWon += scoreInfo.bagelsWon;
    const matchCandidate = { opponent: opponentName, score: String(m.score || ""), date: String(m.date || ""), seasonName: season?.name || sid || "Unknown ladder season", totalGames: scoreInfo.totalGames, didWin };
    if (!longestMatch || matchCandidate.totalGames > longestMatch.totalGames) longestMatch = matchCandidate;

    wins += didWin ? 1 : 0;
    if (didWin) {
      currentStreak += 1;
      bestStreak = Math.max(bestStreak, currentStreak);
      if (isChallenger) {
        successfulChallenges += 1;
        challengeStreak += 1;
        bestChallengeStreak = Math.max(bestChallengeStreak, challengeStreak);
      } else {
        successfulDefences += 1;
        challengeStreak = 0;
      }
    } else {
      currentStreak = 0;
      challengeStreak = 0;
    }
    setsWon += ownSets; setsLost += oppSets; gamesWon += ownGames; gamesLost += oppGames;

    const opponentKey = opponentName.toLowerCase();
    const oppRow = opponentMap.get(opponentKey) || { name: opponentName, played: 0, wins: 0, losses: 0 };
    oppRow.played += 1; if (didWin) oppRow.wins += 1; else oppRow.losses += 1; opponentMap.set(opponentKey, oppRow);

    const seasonRow = seasonMap.get(sid) || { seasonId: sid, name: season?.name || sid || "Unknown season", startDate: season?.start_date || "", played: 0, wins: 0 };
    seasonRow.played += 1; seasonRow.wins += didWin ? 1 : 0; seasonMap.set(sid, seasonRow);

    return { id: String(m.id), seasonId: sid, seasonName: season?.name || sid, date: String(m.date || ""), opponentName, isChallenger, didWin, score: String(m.score || "") };
  });

  const playerRows = (playerRes.data || []).filter((p) => sameName(p.name));
  const positions = [...playerRows.map((p) => Number(p.position)), ...observedPositions].filter((n) => Number.isFinite(n) && n > 0);
  const seasonsPlayed = new Set([...careerMatches.map((m) => String(m.season_id || "")), ...playerRows.map((p) => String(p.season_id || ""))].filter(Boolean));
  const matchupRows = [...opponentMap.values()].map((x) => ({ ...x, winPct: x.played ? Math.round((x.wins / x.played) * 100) : 0 }));
  const bestVs = [...matchupRows].sort((a,b) => b.winPct-a.winPct || b.played-a.played || b.wins-a.wins)[0] || null;
  const worstVs = [...matchupRows].sort((a,b) => a.winPct-b.winPct || b.played-a.played || b.losses-a.losses)[0] || null;
  const mostFrequentOpponent = [...matchupRows].sort((a,b) => b.played-a.played || a.name.localeCompare(b.name))[0] || null;
  let daysAtOne = 0, numberOneDefences = 0;
  for (const sid of seasonsPlayed) {
    const season = seasonById.get(sid);
    const seasonPlayers = (playerRes.data || []).filter((x) => String(x.season_id || "") === sid).map((x) => ({ pid: String(x.pid), name: String(x.name || ""), position: asNumber(x.position, 0) }));
    const seasonMatches = (matchRes.data || []).filter((x) => String(x.season_id || "") === sid).map((x) => ({ id: String(x.id), date: String(x.date || ""), score: String(x.score || ""), challengerPid: String(x.challenger_pid || ""), opponentPid: String(x.opponent_pid || ""), winnerId: x.winner_id === "p1" ? "p1" : "p2", challengerStartPos: asNumber(x.challenger_start_pos,0), opponentStartPos: asNumber(x.opponent_start_pos,0), ladderMoveApplied: Boolean(x.ladder_move_applied) }));
    const oneStats = computeNumberOneStats(seasonPlayers, seasonMatches, season, Date.now());
    for (const pr of seasonPlayers.filter((x) => sameName(x.name))) { const v = oneStats.get(pr.pid); if (v) { daysAtOne += v.daysAtOne; numberOneDefences += v.numberOneDefences; } }
  }

  return {
    name: playerName,
    played: normalized.length,
    wins,
    losses: normalized.length - wins,
    winPct: normalized.length ? Math.round((wins / normalized.length) * 100) : 0,
    successfulChallenges,
    successfulDefences,
    daysAtOne,
    numberOneDefences,
    biggestUpset,
    worstDefeat,
    longestMatch,
    bagelSetsWon,
    bestChallengeStreak,
    mostFrequentOpponent,
    bestVs,
    worstVs,
    bestStreak,
    setsWon,
    setsLost,
    gamesWon,
    gamesLost,
    highestPosition: positions.length ? Math.min(...positions) : null,
    lowestPosition: positions.length ? Math.max(...positions) : null,
    seasonsPlayed: seasonsPlayed.size,
    headToHead: matchupRows.sort((a, b) => b.played - a.played || b.wins - a.wins || a.name.localeCompare(b.name)),
    seasons: [...seasonMap.values()].map((x) => ({ ...x, losses: x.played - x.wins, winPct: x.played ? Math.round((x.wins / x.played) * 100) : 0 })).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate))),
    recent: [...normalized].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id))).slice(0, 10),
  };
}

async function adminAction(pin, action, payload = {}) {
  const res = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin, action, payload }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Admin action failed.");
  return data;
}

async function saveCloudState(pin, fullState, seasonId) {
  const payload = {
    seasonId,
    playerCounts: { mens: fullState.mens.playerCount, womens: fullState.womens.playerCount },
    players: [...fullState.mens.players, ...fullState.womens.players],
    matches: [...fullState.mens.matches, ...fullState.womens.matches],
  };
  return adminAction(pin, "saveState", payload);
}

export default function App() {
  const [state, setState] = useState(() => defaultState());
  const [activeDivision, setActiveDivision] = useState("mens");
  const [seasons, setSeasons] = useState([]);
  const [activeSeasonId, setActiveSeasonId] = useState(LEGACY_SEASON_ID);
  const [metaReady, setMetaReady] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [ladderView, setLadderView] = useState("live");

  const current = state[activeDivision];
  const { players, matches, playerCount } = current;

  const [cloudError, setCloudError] = useState("");
  const [cloudLoading, setCloudLoading] = useState(true);
  const [dirty, setDirty] = useState(false);

  const [locked, setLocked] = useState(true);
  const [sortKey, setSortKey] = useState("position");
  const [sortDir, setSortDir] = useState("asc");

  const [matchDate, setMatchDate] = useState(formatDateISO(new Date()));
  const [matchPos, setMatchPos] = useState("1");
  const [challengerPid, setChallengerPid] = useState("");
  const [score, setScore] = useState("");
  const [scoreCells, setScoreCells] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");

  const [dropPeriodKey, setDropPeriodKey] = useState("apr26_may31");
  const [selectedDropPids, setSelectedDropPids] = useState([]);
  const [withdrawPid, setWithdrawPid] = useState("");
  const [manualMovePid, setManualMovePid] = useState("");
  const [manualMovePosition, setManualMovePosition] = useState("1");

  const [matchAddedOpen, setMatchAddedOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState(null);

  const [playerModalOpen, setPlayerModalOpen] = useState(false);
  const [playerModalPid, setPlayerModalPid] = useState(null);
  const [playerModalView, setPlayerModalView] = useState("recent");
  const [lifetimeStats, setLifetimeStats] = useState(null);
  const [lifetimeLoading, setLifetimeLoading] = useState(false);
  const [lifetimeError, setLifetimeError] = useState("");

  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editDate, setEditDate] = useState("");
  const [editWinner, setEditWinner] = useState("p2");
  const [editScore, setEditScore] = useState("");
  const [editError, setEditError] = useState("");

  const [pinOpen, setPinOpen] = useState(false);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinPurpose, setPinPurpose] = useState("unlock");
  const [pinPayload, setPinPayload] = useState(null);
  const pinRef = useRef(null);
  const matchDateManuallyChangedRef = useRef(false);

  const liveRef = useRef(null);
  const ladderRef = useRef(null);
  const addMatchRef = useRef(null);
  const historyRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const meta = await fetchSeasonMeta();
        if (!alive) return;
        setSeasons(meta.seasons);
        setActiveSeasonId(meta.defaultSeasonId);
        setActiveDivision(meta.defaultDivision);
      } catch (e) {
        if (alive) setCloudError(String(e?.message || e || "Failed to load seasons."));
      } finally {
        if (alive) setMetaReady(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!metaReady || !activeSeasonId) return undefined;
    let alive = true;
    async function load() {
      setCloudError(""); setCloudLoading(true);
      try { const cloudState = await fetchCloudState(activeSeasonId); if (alive) { setState(cloudState); setDirty(false); } }
      catch (e) { if (alive) setCloudError(String(e?.message || e || "Failed to load from cloud.")); }
      finally { if (alive) setCloudLoading(false); }
    }
    load();
    if (!supabase) return () => { alive = false; };
    const channel = supabase.channel(`heron-ladder-${activeSeasonId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `season_id=eq.${activeSeasonId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `season_id=eq.${activeSeasonId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, load)
      .subscribe();
    return () => { alive = false; supabase.removeChannel(channel); };
  }, [metaReady, activeSeasonId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setMatchPos("1");
    setChallengerPid("");
    setScore("");
    setScoreCells(["", "", "", "", "", ""]);
    setError("");
    matchDateManuallyChangedRef.current = false;
    setMatchDate(formatDateISO(new Date()));
    setManualMovePid("");
    setManualMovePosition("1");
  }, [activeDivision]);

  useEffect(() => {
    const mp = clamp(asNumber(matchPos, 1), 1, playerCount);
    if (String(mp) !== matchPos) setMatchPos(String(mp));
  }, [playerCount, matchPos]);

  useEffect(() => {
    const refreshDefaultMatchDate = () => {
      if (!matchDateManuallyChangedRef.current) setMatchDate(formatDateISO(new Date()));
    };
    window.addEventListener("focus", refreshDefaultMatchDate);
    return () => window.removeEventListener("focus", refreshDefaultMatchDate);
  }, []);

  useEffect(() => {
    // Keep an untouched Add Match form pinned to today's date, including across midnight.
    if (!matchDateManuallyChangedRef.current) setMatchDate(formatDateISO(new Date(nowTick)));
  }, [nowTick]);

  function scrollToRef(ref) {
    ref?.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function patchCurrentDivision(patchFn) {
    setState((prev) => ({
      ...prev,
      [activeDivision]: patchFn(prev[activeDivision]),
    }));
  }

  function openPin(purpose, payload) {
    setPinPurpose(purpose);
    setPinPayload(payload || null);
    setPinValue("");
    setPinError("");
    setPinOpen(true);
    setTimeout(() => pinRef.current?.focus?.(), 0);
  }

  function closePin() {
    setPinOpen(false);
    setPinValue("");
    setPinError("");
  }

  async function submitPin() {
    const pin = String(pinValue || "");
    if (!pin) {
      setPinError("Enter PIN.");
      return;
    }

    try {
      if (pinPurpose === "unlock") {
        setLocked(false);
        closePin();
        return;
      }

      if (pinPurpose === "add") {
        closePin();
        await actuallyAddMatch(pin);
        return;
      }

      if (pinPurpose === "delete") {
        const matchId = pinPayload?.matchId;
        closePin();
        setDeleteTargetId(matchId);
        setDeleteConfirmOpen(true);
        setPinPayload({ matchId, pin });
        return;
      }

      if (pinPurpose === "edit") {
        closePin();
        await actuallySaveEdit(pin);
        return;
      }

      if (pinPurpose === "save") {
        closePin();
        await actuallySaveAll(pin);
        return;
      }

      if (pinPurpose === "drop3") {
        closePin();
        await actuallyDropThreePlaces(pin);
        return;
      }

      if (pinPurpose === "withdraw") {
        closePin();
        await actuallyWithdrawPlayer(pin);
        return;
      }

      if (pinPurpose === "manualMove") {
        closePin();
        await actuallyManualMovePlayer(pin);
        return;
      }
    } catch (e) {
      setPinError(String(e?.message || e || "PIN action failed"));
    }
  }

  function updatePlayer(pid, field, value) {
    if (locked) return;
    setDirty(true);
    patchCurrentDivision((divisionState) => ({
      ...divisionState,
      players: divisionState.players.map((p) => {
        if (p.pid !== pid) return p;
        if (field === "name") return { ...p, name: String(value) };
        return { ...p, [field]: asNumber(value, 0) };
      }),
    }));
  }

  const visiblePlayers = useMemo(
    () => players.filter((p) => isWithdrawnPlayer(p) || (p.position >= 1 && p.position <= playerCount)),
    [players, playerCount]
  );

  const initialPlayers = useMemo(() => reconstructInitialPlayers(players, matches), [players, matches]);
  const initialPositionByPid = useMemo(() => new Map(initialPlayers.map((p) => [p.pid, p.position])), [initialPlayers]);
  const calculatedPlayers = useMemo(
    () => visiblePlayers.map((p) => ({
      ...p,
      setDiff: (p.setsWon || 0) - (p.setsLost || 0),
      gameDiff: (p.gamesWon || 0) - (p.gamesLost || 0),
      ladderProgress: asNumber(initialPositionByPid.get(p.pid), p.position) - p.position,
    })),
    [visiblePlayers, initialPositionByPid]
  );

  const displayedPlayers = useMemo(() => {
    const arr = [...calculatedPlayers];
    arr.sort((a, b) => compareByColumn(a, b, sortKey, sortDir));
    return arr;
  }, [calculatedPlayers, sortKey, sortDir]);

  const opponent = useMemo(() => {
    const pos = Number(matchPos) || 1;
    return players.find((p) => p.position === pos) || null;
  }, [matchPos, players]);

  const challenger = useMemo(() => players.find((p) => p.pid === challengerPid) || null, [challengerPid, players]);

  function updateScoreCell(row, col, rawValue) {
    const cleaned = String(rawValue || "").replace(/\D/g, "").slice(0, 2);
    setScoreCells((prev) => {
      const next = [...prev];
      next[row * 3 + col] = cleaned;

      const sets = [];
      for (let i = 0; i < 3; i++) {
        const p1 = next[i];
        const p2 = next[3 + i];
        if (p1 !== "" && p2 !== "") sets.push(`${p1}-${p2}`);
      }
      setScore(sets.join(" "));
      return next;
    });
  }

  const scoreOutcome = useMemo(() => {
    const parsed = parseScore(score);
    if (!parsed.valid) return { valid: false, winnerId: "", label: "Awaiting result" };

    const validity = validateSets(parsed.sets);
    if (!validity.ok) return { valid: false, winnerId: "", label: "Awaiting result" };

    const { p1Sets, p2Sets } = computeFromSets(parsed.sets);
    const winnerId = p1Sets > p2Sets ? "p1" : "p2";
    const winningPlayer = winnerId === "p1" ? challenger : opponent;
    return {
      valid: true,
      winnerId,
      label: String(winningPlayer?.name || "").trim() || (winnerId === "p1" ? "Challenger" : "Opponent"),
    };
  }, [score, challenger, opponent]);

  const selectablePlayers = useMemo(
    () =>
      players
        .filter((p) => p.position >= 1 && p.position <= playerCount)
        .filter((p) => !isWithdrawnPlayer(p))
        .filter((p) => String(p.name || "").trim().length > 0)
        .sort((a, b) => a.position - b.position),
    [players, playerCount]
  );

  const activeSeason = seasons.find((x) => String(x.id) === String(activeSeasonId)) || null;
  const dropPeriods = useMemo(() => seasonDropPeriods(activeSeason), [activeSeason]);

  const selectedDropPeriod = useMemo(
    () => dropPeriods.find((p) => p.key === dropPeriodKey) || dropPeriods[0] || null,
    [dropPeriodKey, dropPeriods]
  );

  const eligibleDropPlayers = useMemo(() => {
    const period = selectedDropPeriod;
    if (!period) return [];

    return players
      .filter((p) => p.position >= 1 && p.position <= playerCount)
      .filter((p) => String(p.name || "").trim().length > 0)
      .filter((p) => !isWithdrawnPlayer(p))
      .filter((p) => {
        return !matches.some((m) => {
          if (String(m.score || "").startsWith("ADMIN:")) return false;
          const date = String(m.date || "");
          if (date < period.start || date > period.end) return false;
          return m.challengerPid === p.pid || m.opponentPid === p.pid;
        });
      })
      .sort((a, b) => a.position - b.position);
  }, [players, matches, playerCount, selectedDropPeriod]);

  useEffect(() => {
    if (dropPeriods.length && !dropPeriods.some((p) => p.key === dropPeriodKey)) setDropPeriodKey(dropPeriods[0].key);
  }, [dropPeriods, dropPeriodKey]);

  useEffect(() => {
    setSelectedDropPids(eligibleDropPlayers.map((p) => p.pid));
  }, [dropPeriodKey, activeDivision, eligibleDropPlayers.length]);

  const leaderboardTop3 = useMemo(() => {
    const named = calculatedPlayers.filter((p) => !isWithdrawnPlayer(p) && String(p.name || "").trim().length > 0);
    return [...named].sort((a, b) => a.position - b.position).slice(0, 3);
  }, [calculatedPlayers]);

  const ladderMonthColumns = useMemo(() => seasonMonthColumns(activeSeason), [activeSeason]);
  const monthlyPlayedByPid = useMemo(() => {
    const map = new Map();
    for (const m of matches) {
      if (String(m.score || "").startsWith("ADMIN:")) continue;
      const key = String(m.date || "").slice(0,7);
      for (const pid of [m.challengerPid, m.opponentPid]) {
        if (!map.has(pid)) map.set(pid, new Map());
        const inner = map.get(pid); inner.set(key, (inner.get(key)||0)+1);
      }
    }
    return map;
  }, [matches]);
  const topClimbers = useMemo(() => {
    const eligible = calculatedPlayers
      .filter((p) => !isWithdrawnPlayer(p) && String(p.name || "").trim() && p.ladderProgress > 0)
      .sort((a, b) => b.ladderProgress - a.ladderProgress || a.position - b.position);

    const topProgressLevels = [...new Set(eligible.map((p) => p.ladderProgress))].slice(0, 3);
    return topProgressLevels.map((progress, index) => ({
      rank: index + 1,
      progress,
      players: eligible.filter((p) => p.ladderProgress === progress),
    }));
  }, [calculatedPlayers]);

  const seasonBannerStats = useMemo(() => {
    const realMatches = matches.filter((m) => !String(m.score || "").startsWith("ADMIN:"));
    const activity = new Map();
    for (const m of realMatches) {
      activity.set(m.challengerPid, (activity.get(m.challengerPid) || 0) + 1);
      activity.set(m.opponentPid, (activity.get(m.opponentPid) || 0) + 1);
    }
    const activePlayers = calculatedPlayers
      .filter((p) => !isWithdrawnPlayer(p) && String(p.name || "").trim())
      .map((p) => ({ ...p, seasonMatches: activity.get(p.pid) || 0 }))
      .sort((a, b) => b.seasonMatches - a.seasonMatches || a.position - b.position);
    const maxMatches = activePlayers[0]?.seasonMatches || 0;
    const mostActive = maxMatches > 0 ? activePlayers.filter((p) => p.seasonMatches === maxMatches) : [];
    return {
      mostActive,
      mostActiveMatches: maxMatches,
      totalMatches: realMatches.length,
    };
  }, [matches, calculatedPlayers]);

  const matchesView = useMemo(() => {
    const byPid = new Map(players.map((p) => [p.pid, p]));
    const isActive = (pid) => {
      const p = byPid.get(pid);
      return p ? !isWithdrawnPlayer(p) && p.position >= 1 && p.position <= playerCount : false;
    };

    return [...matches]
      .sort((a, b) => {
        const d = String(b.date).localeCompare(String(a.date));
        if (d !== 0) return d;
        return String(b.id).localeCompare(String(a.id));
      })
      .map((m) => {
        const p1 = byPid.get(m.challengerPid);
        const p2 = byPid.get(m.opponentPid);
        const p1Snapshot = String(m.challengerName || "").trim();
        const p2Snapshot = String(m.opponentName || "").trim();
        const p1Base = p1Snapshot || p1?.name || "(Unknown)";
        const p2Base = p2Snapshot || p2?.name || "(Unknown)";
        const p1Name = p1Base;
        const p2Name = p2Base;
        const winnerSnapshot = String(m.winnerNameSnapshot || "").trim();
        const winnerName = winnerSnapshot || (m.winnerId === "p1" ? p1Name : p2Name);
        return { ...m, p1Name, p2Name, winnerName: winnerName || "(Unknown)" };
      });
  }, [matches, players, playerCount]);

  const seasonLabel = activeSeason?.name || "Season";

  const analytics = useMemo(() => {
    const realMatches = matchesView.filter((m) => !String(m.score || "").startsWith("ADMIN:"));
    const namedActive = calculatedPlayers.filter((p) => !isWithdrawnPlayer(p) && String(p.name || "").trim());
    const monthLabels = [
      ["apr", "Apr"], ["may", "May"], ["jun", "Jun"], ["jul", "Jul"], ["aug", "Aug"],
      ["sep", "Sep"], ["oct", "Oct"], ["nov", "Nov"], ["dec", "Dec"], ["jan", "Jan"], ["feb", "Feb"], ["mar", "Mar"],
    ];
    const monthlyCounts = new Map();
    let deciders = 0;
    let challengerWins = 0;

    for (const m of realMatches) {
      const d = new Date(`${m.date}T12:00:00`);
      if (!Number.isNaN(d.getTime())) {
        const key = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"][d.getMonth()];
        monthlyCounts.set(key, (monthlyCounts.get(key) || 0) + 1);
      }
      const parsed = parseScore(m.score);
      if (parsed.valid && parsed.sets.length >= 3) deciders += 1;
      if (m.winnerId === "p1") challengerWins += 1;
    }

    const seasonMonths = (() => {
      const start = activeSeason?.start_date ? new Date(`${activeSeason.start_date}T12:00:00`) : null;
      const end = activeSeason?.end_date ? new Date(`${activeSeason.end_date}T12:00:00`) : null;
      if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return monthLabels.filter(([key]) => monthlyCounts.has(key));
      const out = [];
      const cursor = new Date(start.getFullYear(), start.getMonth(), 1, 12);
      const endMonth = new Date(end.getFullYear(), end.getMonth(), 1, 12);
      while (cursor <= endMonth && out.length < 12) {
        const key = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"][cursor.getMonth()];
        const label = cursor.toLocaleDateString("en-GB", { month: "short" });
        out.push([key, label]);
        cursor.setMonth(cursor.getMonth() + 1);
      }
      return out;
    })();

    const playerRows = namedActive.map((p) => {
      const pm = realMatches.filter((m) => m.challengerPid === p.pid || m.opponentPid === p.pid);
      const chronological = [...pm].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
      let run = 0;
      let bestStreak = 0;
      const results = chronological.map((m) => {
        const won = (m.winnerId === "p1" && m.challengerPid === p.pid) || (m.winnerId === "p2" && m.opponentPid === p.pid);
        if (won) { run += 1; bestStreak = Math.max(bestStreak, run); } else run = 0;
        return won ? "W" : "L";
      });
      const wins = results.filter((x) => x === "W").length;
      const successfulChallenges = pm.filter((m) => m.challengerPid === p.pid && m.winnerId === "p1").length;
      const successfulDefences = pm.filter((m) => m.opponentPid === p.pid && m.winnerId === "p2").length;
      return {
        pid: p.pid, name: p.name, position: p.position, played: pm.length, wins,
        winPct: pm.length ? Math.round((wins / pm.length) * 100) : 0,
        successfulChallenges, successfulDefences,
        setDiff: p.setDiff || 0, gameDiff: p.gameDiff || 0,
        form: results.slice(-5).reverse(), bestStreak,
      };
    }).filter((p) => p.played > 0).sort((a, b) => b.wins - a.wins || b.winPct - a.winPct || b.gameDiff - a.gameDiff || a.position - b.position);

    const playerNameByPid = new Map(calculatedPlayers.map((p) => [p.pid, String(p.name || "").trim() || "Unknown"]));
    const h2hMap = new Map();
    for (const m of realMatches) {
      const pids = [m.challengerPid, m.opponentPid].sort();
      const key = pids.join("__");
      if (!pids[0] || !pids[1] || pids[0] === pids[1]) continue;
      const existing = h2hMap.get(key) || { key, playerAPid: pids[0], playerBPid: pids[1], playerAWins: 0, playerBWins: 0, matches: [] };
      const winnerPid = m.winnerId === "p1" ? m.challengerPid : m.opponentPid;
      if (winnerPid === existing.playerAPid) existing.playerAWins += 1;
      else if (winnerPid === existing.playerBPid) existing.playerBWins += 1;
      existing.matches.push(m);
      h2hMap.set(key, existing);
    }
    const headToHead = [...h2hMap.values()].map((row) => {
      const latest = [...row.matches].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)))[0];
      const latestWinnerPid = latest.winnerId === "p1" ? latest.challengerPid : latest.opponentPid;
      const latestLoserPid = latestWinnerPid === latest.challengerPid ? latest.opponentPid : latest.challengerPid;
      const playerAName = playerNameByPid.get(row.playerAPid) || "Unknown";
      const playerBName = playerNameByPid.get(row.playerBPid) || "Unknown";
      return {
        key: row.key, playerAName, playerBName, meetings: row.matches.length,
        playerAWins: row.playerAWins, playerBWins: row.playerBWins,
        leader: row.playerAWins === row.playerBWins ? "Tied" : (row.playerAWins > row.playerBWins ? playerAName : playerBName),
        latestWinner: playerNameByPid.get(latestWinnerPid) || "Unknown",
        latestLoser: playerNameByPid.get(latestLoserPid) || "Unknown",
        latestDate: String(latest.date || ""),
        latestScore: formatScoreForPlayer(latest.score, latestWinnerPid === latest.challengerPid),
      };
    }).sort((a, b) => b.meetings - a.meetings || a.playerAName.localeCompare(b.playerAName) || a.playerBName.localeCompare(b.playerBName));

    return {
      activePlayers: namedActive.length,
      totalMatches: realMatches.length,
      deciders,
      deciderRate: realMatches.length ? Math.round((deciders / realMatches.length) * 100) : 0,
      challengerWins,
      challengeWinRate: realMatches.length ? Math.round((challengerWins / realMatches.length) * 100) : 0,
      monthly: seasonMonths.map(([key, label]) => ({ key, label, matches: monthlyCounts.get(key) || 0 })),
      playerRows,
      headToHead,
    };
  }, [matchesView, calculatedPlayers, activeSeason]);

  const lastResultByPid = useMemo(() => {
    const map = new Map();
    for (const m of matchesView) {
      if (!map.has(m.challengerPid)) map.set(m.challengerPid, m.winnerId === "p1" ? "win" : "loss");
      if (!map.has(m.opponentPid)) map.set(m.opponentPid, m.winnerId === "p2" ? "win" : "loss");
      if (map.size >= players.length) break;
    }
    return map;
  }, [matchesView, players.length]);

  function latestResultStyle(pid) {
    const r = lastResultByPid.get(pid);
    if (r === "win") return { background: "rgba(34, 197, 94, 0.22)" };
    if (r === "loss") return { background: "rgba(239, 68, 68, 0.22)" };
    return undefined;
  }

  function toggleSort(nextKey) {
    setSortKey((prev) => {
      if (prev !== nextKey) {
        setSortDir("asc");
        return nextKey;
      }
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return prev;
    });
  }

  function sortIndicator(key) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  function requestAddMatch() {
    setError("");
    if (locked) {
      setError("Locked: Admin unlock required.");
      return;
    }
    openPin("add");
  }

  async function actuallyAddMatch(pin) {
    setError("");
    if (locked) return setError("Locked: Admin unlock required.");

    const pos = clamp(Number(matchPos) || 1, 1, playerCount);
    const p2 = players.find((p) => p.position === pos);
    if (!p2) return setError("Invalid position selected.");
    if (!String(p2.name || "").trim()) return setError(`The player at position #${pos} has no name yet.`);

    if (!challengerPid) return setError("Pick a Challenger.");
    const p1 = players.find((p) => p.pid === challengerPid);
    if (!p1 || !String(p1.name || "").trim()) return setError("Challenger is missing / has no name.");
    if (p1.pid === p2.pid) return setError("Challenger can't play themselves.");

    const parsed = parseScore(score);
    if (!parsed.valid) return setError(parsed.message || "Score not recognised.");

    const validity = validateSets(parsed.sets);
    if (!validity.ok) return setError(validity.message);

    const { p1Sets, p2Sets, p1Games, p2Games } = computeFromSets(parsed.sets);
    const matchWinner = p1Sets > p2Sets ? "p1" : "p2";
    const monthKey = monthKeyFromDateISO(matchDate);
    const challengerStartPos = p1.position;
    const opponentStartPos = p2.position;

    const shouldMove = matchWinner === "p1" && challengerStartPos > opponentStartPos;
    const moved = shouldMove ? applyLadderMove(players, p1.pid, opponentStartPos) : { players, applied: false };

    const matchRecord = {
      id: uid(),
      division: activeDivision,
      date: matchDate,
      positionPlayedFor: opponentStartPos,
      challengerPid: p1.pid,
      opponentPid: p2.pid,
      winnerId: matchWinner,
      challengerName: p1.name || "",
      opponentName: p2.name || "",
      winnerNameSnapshot: matchWinner === "p1" ? (p1.name || "") : (p2.name || ""),
      score: String(score || "").trim(),
      surface: "",
      challengerStartPos,
      opponentStartPos,
      ladderMoveApplied: moved.applied,
    };

    const nextState = {
      ...state,
      [activeDivision]: {
        ...current,
        matches: [matchRecord, ...current.matches],
        players: current.players
          .map((p) => {
            if (p.pid !== p1.pid && p.pid !== p2.pid) return p;
            const isP1 = p.pid === p1.pid;
            const setsWon = isP1 ? p1Sets : p2Sets;
            const setsLost = isP1 ? p2Sets : p1Sets;
            const gamesWon = isP1 ? p1Games : p2Games;
            const gamesLost = isP1 ? p2Games : p1Games;
            const didWin = (matchWinner === "p1" && isP1) || (matchWinner === "p2" && !isP1);
            const next = {
              ...p,
              matchesPlayed: (p.matchesPlayed || 0) + 1,
              matchesWon: (p.matchesWon || 0) + (didWin ? 1 : 0),
              setsWon: (p.setsWon || 0) + setsWon,
              setsLost: (p.setsLost || 0) + setsLost,
              gamesWon: (p.gamesWon || 0) + gamesWon,
              gamesLost: (p.gamesLost || 0) + gamesLost,
            };
            if (monthKey) next[monthKey] = (p[monthKey] || 0) + 1;
            return next;
          })
          .map((p) => {
            if (!moved.applied) return p;
            const after = moved.players.find((x) => x.pid === p.pid);
            return after ? { ...p, position: after.position } : p;
          }),
      },
    };

    setState(nextState);
    setDirty(true);

    try {
      await saveCloudState(pin, nextState, activeSeasonId);
      setDirty(false);
      setMatchAddedOpen(true);
      setScore("");
      setScoreCells(["", "", "", "", "", ""]);
      matchDateManuallyChangedRef.current = false;
      setMatchDate(formatDateISO(new Date()));
    } catch (e) {
      setError(String(e?.message || e || "Failed to save to cloud."));
    }
  }

  function requestDeleteMatch(id) {
    if (locked) return;
    openPin("delete", { matchId: id });
  }

  async function deleteMatchConfirmed() {
    const id = deleteTargetId;
    const pin = pinPayload?.pin;
    if (!id || !pin) {
      setDeleteConfirmOpen(false);
      return;
    }

    const match = matches.find((m) => m.id === id);
    if (!match) {
      setDeleteConfirmOpen(false);
      return;
    }

    let nextPlayers = current.players;

    if (isAdminDropMatch(match)) {
      if (!isLatestActionForPlayer(match)) {
        setError("That drop action can only be reversed if it is the player's most recent action.");
        setDeleteConfirmOpen(false);
        setDeleteTargetId(null);
        setPinPayload(null);
        return;
      }

      nextPlayers = moveActivePlayerToPosition(
        current.players,
        match.challengerPid,
        Number(match.challengerStartPos || match.positionPlayedFor || 1)
      );

      const nextState = {
        ...state,
        [activeDivision]: {
          ...current,
          matches: current.matches.filter((m) => m.id !== id),
          players: nextPlayers,
        },
      };

      setState(nextState);
      setDirty(true);

      try {
        await saveCloudState(pin, nextState, activeSeasonId);
        setDirty(false);
      } catch (e) {
        setError(String(e?.message || e || "Failed to reverse drop action in cloud."));
      }

      setDeleteConfirmOpen(false);
      setDeleteTargetId(null);
      setPinPayload(null);
      return;
    }

    const parsed = parseScore(match.score);

    if (parsed.valid) {
      const validity = validateSets(parsed.sets);
      if (validity.ok) {
        const { p1Sets, p2Sets, p1Games, p2Games } = computeFromSets(parsed.sets);
        const monthKey = monthKeyFromDateISO(match.date);
        nextPlayers = nextPlayers.map((p) => {
          if (p.pid !== match.challengerPid && p.pid !== match.opponentPid) return p;
          const isP1 = p.pid === match.challengerPid;
          const setsWon = isP1 ? p1Sets : p2Sets;
          const setsLost = isP1 ? p2Sets : p1Sets;
          const gamesWon = isP1 ? p1Games : p2Games;
          const gamesLost = isP1 ? p2Games : p1Games;
          const didWin = (match.winnerId === "p1" && isP1) || (match.winnerId === "p2" && !isP1);
          const out = {
            ...p,
            matchesPlayed: clampMin0((p.matchesPlayed || 0) - 1),
            matchesWon: clampMin0((p.matchesWon || 0) - (didWin ? 1 : 0)),
            setsWon: clampMin0((p.setsWon || 0) - setsWon),
            setsLost: clampMin0((p.setsLost || 0) - setsLost),
            gamesWon: clampMin0((p.gamesWon || 0) - gamesWon),
            gamesLost: clampMin0((p.gamesLost || 0) - gamesLost),
          };
          if (monthKey) out[monthKey] = clampMin0((p[monthKey] || 0) - 1);
          return out;
        });
      }
    }

    if (match.ladderMoveApplied) {
      nextPlayers = reverseLadderMove(nextPlayers, match.challengerPid, match.challengerStartPos, match.opponentStartPos);
    }

    const nextState = {
      ...state,
      [activeDivision]: {
        ...current,
        matches: current.matches.filter((m) => m.id !== id),
        players: nextPlayers,
      },
    };

    setState(nextState);
    setDirty(true);

    try {
      await saveCloudState(pin, nextState, activeSeasonId);
      setDirty(false);
    } catch (e) {
      setError(String(e?.message || e || "Failed to delete in cloud."));
    }

    setDeleteConfirmOpen(false);
    setDeleteTargetId(null);
    setPinPayload(null);
  }

  function openEditMatch(match) {
    if (locked) return;
    setEditError("");
    setEditId(match.id);
    setEditDate(match.date);
    setEditWinner(match.winnerId);
    setEditScore(match.score);
    setEditOpen(true);
  }

  function requestSaveEdit() {
    if (locked) return;
    openPin("edit");
  }

  async function actuallySaveEdit(pin) {
    setEditError("");
    const id = editId;
    if (!id) return setEditError("No match selected.");

    const original = current.matches.find((m) => m.id === id);
    if (!original) return setEditError("Match not found.");

    const parsedNew = parseScore(editScore);
    if (!parsedNew.valid) return setEditError(parsedNew.message || "Score not recognised.");
    const vNew = validateSets(parsedNew.sets);
    if (!vNew.ok) return setEditError(vNew.message);

    const working = {
      ...current,
      players: current.players.map((p) => ({ ...p })),
      matches: [...current.matches],
    };

    const applyMatchDelta = (matchObj, dir) => {
      const parsed = parseScore(matchObj.score);
      if (!parsed.valid) throw new Error("Stored score invalid; can't edit safely.");
      const valid = validateSets(parsed.sets);
      if (!valid.ok) throw new Error("Stored score invalid; can't edit safely.");
      const { p1Sets, p2Sets, p1Games, p2Games } = computeFromSets(parsed.sets);
      const monthKey = monthKeyFromDateISO(matchObj.date);

      working.players = working.players.map((p) => {
        if (p.pid !== matchObj.challengerPid && p.pid !== matchObj.opponentPid) return p;
        const isP1 = p.pid === matchObj.challengerPid;
        const setsWon = isP1 ? p1Sets : p2Sets;
        const setsLost = isP1 ? p2Sets : p1Sets;
        const gamesWon = isP1 ? p1Games : p2Games;
        const gamesLost = isP1 ? p2Games : p1Games;
        const didWin = (matchObj.winnerId === "p1" && isP1) || (matchObj.winnerId === "p2" && !isP1);
        const out = {
          ...p,
          matchesPlayed: clampMin0((p.matchesPlayed || 0) + dir),
          matchesWon: clampMin0((p.matchesWon || 0) + (didWin ? 1 : 0) * dir),
          setsWon: clampMin0((p.setsWon || 0) + setsWon * dir),
          setsLost: clampMin0((p.setsLost || 0) + setsLost * dir),
          gamesWon: clampMin0((p.gamesWon || 0) + gamesWon * dir),
          gamesLost: clampMin0((p.gamesLost || 0) + gamesLost * dir),
        };
        if (monthKey) out[monthKey] = clampMin0((p[monthKey] || 0) + dir);
        return out;
      });
    };

    if (original.ladderMoveApplied) {
      working.players = reverseLadderMove(working.players, original.challengerPid, original.challengerStartPos, original.opponentStartPos);
    }

    applyMatchDelta(original, -1);

    const edited = {
      ...original,
      date: editDate,
      surface: original.surface || "",
      winnerId: editWinner,
      challengerName: original.challengerName || "",
      opponentName: original.opponentName || "",
      winnerNameSnapshot: editWinner === "p1" ? (original.challengerName || "") : (original.opponentName || ""),
      score: String(editScore || "").trim(),
    };

    const p1 = working.players.find((p) => p.pid === edited.challengerPid);
    const p2 = working.players.find((p) => p.pid === edited.opponentPid);
    if (!p1 || !p2) return setEditError("Players missing.");

    const challengerStartPos = p1.position;
    const opponentStartPos = p2.position;
    const shouldMove = edited.winnerId === "p1" && challengerStartPos > opponentStartPos;
    const moved = shouldMove ? applyLadderMove(working.players, p1.pid, opponentStartPos) : { players: working.players, applied: false };

    edited.challengerStartPos = challengerStartPos;
    edited.opponentStartPos = opponentStartPos;
    edited.positionPlayedFor = opponentStartPos;
    edited.ladderMoveApplied = moved.applied;

    working.players = working.players.map((p) => {
      const after = moved.players.find((x) => x.pid === p.pid);
      return after ? { ...p, position: after.position } : p;
    });

    applyMatchDelta(edited, +1);
    working.matches = working.matches.map((m) => (m.id === edited.id ? edited : m));

    const nextState = {
      ...state,
      [activeDivision]: working,
    };

    setState(nextState);
    setDirty(true);

    try {
      await saveCloudState(pin, nextState, activeSeasonId);
      setDirty(false);
      setEditOpen(false);
      setEditId(null);
    } catch (e) {
      setEditError(String(e?.message || e || "Failed to save edit to cloud."));
    }
  }

  async function actuallySaveAll(pin) {
    setError("");
    try {
      await saveCloudState(pin, state, activeSeasonId);
      setDirty(false);
    } catch (e) {
      setError(String(e?.message || e || "Failed to save to cloud."));
    }
  }

  function isWithdrawnPlayer(p) {
    return Boolean(p?.withdrawn) || String(p?.name || "").startsWith("W - ");
  }

  function isAdminDropMatch(match) {
    return (
      String(match?.score || "").startsWith("ADMIN:") &&
      String(match?.score || "").toLowerCase().includes("moved down 3 places")
    );
  }

  function isLatestActionForPlayer(match) {
    const pid = match?.challengerPid;
    if (!pid) return false;

    const actions = [...current.matches]
      .filter((m) => m.challengerPid === pid || m.opponentPid === pid)
      .sort((a, b) => {
        const d = String(b.date).localeCompare(String(a.date));
        if (d !== 0) return d;
        return String(b.id).localeCompare(String(a.id));
      });

    return actions[0]?.id === match.id;
  }

  function moveActivePlayerToPosition(sourcePlayers, pid, targetPosition) {
    const target = sourcePlayers.find((p) => p.pid === pid);
    if (!target || isWithdrawnPlayer(target)) return sourcePlayers;

    const active = sourcePlayers
      .filter((p) => !isWithdrawnPlayer(p) && p.position >= 1 && p.position <= playerCount)
      .sort((a, b) => a.position - b.position);

    const reserve = sourcePlayers.filter((p) => !isWithdrawnPlayer(p) && (p.position < 1 || p.position > playerCount)).sort((a, b) => a.position - b.position);
    const withdrawn = sourcePlayers
      .filter((p) => isWithdrawnPlayer(p))
      .sort((a, b) => a.position - b.position);

    const currentIndex = active.findIndex((p) => p.pid === pid);
    if (currentIndex === -1) return sourcePlayers;

    const safeTargetIndex = clamp(Number(targetPosition || 1), 1, active.length) - 1;
    const reorderedActive = [...active];
    const [movedPlayer] = reorderedActive.splice(currentIndex, 1);
    reorderedActive.splice(safeTargetIndex, 0, movedPlayer);

    return [
      ...reorderedActive.map((p, i) => ({ ...p, position: i + 1 })),
      ...withdrawn.map((p, i) => ({ ...p, position: reorderedActive.length + i + 1 })),
      ...reserve.map((p, i) => ({ ...p, position: reorderedActive.length + withdrawn.length + i + 1 })),
    ];
  }

  function movePlayerDownByPlaces(sourcePlayers, pid, places) {
    const target = sourcePlayers.find((p) => p.pid === pid);
    if (!target || isWithdrawnPlayer(target)) return sourcePlayers;

    // Withdrawn players are anchored to the bottom. Active players can only
    // be dropped within the active section, never below withdrawn players.
    const active = sourcePlayers
      .filter((p) => !isWithdrawnPlayer(p))
      .sort((a, b) => a.position - b.position);

    const withdrawn = sourcePlayers
      .filter((p) => isWithdrawnPlayer(p))
      .sort((a, b) => a.position - b.position);

    const currentIndex = active.findIndex((p) => p.pid === pid);
    if (currentIndex === -1) return sourcePlayers;

    const newIndex = Math.min(currentIndex + places, active.length - 1);
    if (newIndex === currentIndex) return sourcePlayers;

    const reorderedActive = [...active];
    const [movedPlayer] = reorderedActive.splice(currentIndex, 1);
    reorderedActive.splice(newIndex, 0, movedPlayer);

    return [
      ...reorderedActive.map((p, i) => ({ ...p, position: i + 1 })),
      ...withdrawn.map((p, i) => ({ ...p, position: reorderedActive.length + i + 1 })),
    ];
  }

  function movePlayerToBottom(sourcePlayers, pid) {
    const target = sourcePlayers.find((p) => p.pid === pid);
    if (!target) return sourcePlayers;

    // Withdraw means bottom of the whole ladder, below all active players.
    // Existing withdrawn players remain grouped at the bottom too.
    const activeWithoutTarget = sourcePlayers
      .filter((p) => !isWithdrawnPlayer(p) && p.pid !== pid)
      .sort((a, b) => a.position - b.position);

    const withdrawnWithoutTarget = sourcePlayers
      .filter((p) => isWithdrawnPlayer(p) && p.pid !== pid)
      .sort((a, b) => a.position - b.position);

    const withdrawnTarget = {
      ...target,
      withdrawn: true,
      name: isWithdrawnPlayer(target) ? target.name : `W - ${target.name || "Withdrawn player"}`,
    };

    const rebuilt = [
      ...activeWithoutTarget,
      withdrawnTarget,
      ...withdrawnWithoutTarget,
    ];

    return rebuilt.map((p, i) => ({ ...p, position: i + 1 }));
  }

  function makeAdminLog(player, message, options = {}) {
    return {
      id: `admin_${uid()}`,
      division: activeDivision,
      date: formatDateISO(new Date()),
      positionPlayedFor: player.position,
      challengerPid: player.pid,
      opponentPid: player.pid,
      winnerId: "p2",
      challengerName: player.name || "Player",
      opponentName: "",
      winnerNameSnapshot: "Admin action",
      score: `ADMIN: ${message}`,
      surface: "Admin",
      challengerStartPos: Number(options.challengerStartPos ?? player.position),
      opponentStartPos: Number(options.opponentStartPos ?? player.position),
      ladderMoveApplied: Boolean(options.ladderMoveApplied || false),
    };
  }

  async function actuallyDropThreePlaces(pin) {
    setError("");
    if (locked) return setError("Locked: Admin unlock required.");

    const period = selectedDropPeriod;
    if (!period) return setError("This ladder season does not have valid start and end dates.");
    const chosenPlayers = selectedDropPids
      .map((pid) => players.find((p) => p.pid === pid))
      .filter(Boolean)
      .filter((p) => !isWithdrawnPlayer(p));

    if (chosenPlayers.length === 0) {
      return setError("Choose at least one eligible player to drop 3 places.");
    }

    // Apply from lower-ranked to higher-ranked so multiple drops in one batch
    // do not unexpectedly shove already-processed players around.
    const orderedPlayers = [...chosenPlayers].sort((a, b) => b.position - a.position);

    let nextPlayers = current.players;
    const adminLogs = [];

    for (const player of orderedPlayers) {
      const before = nextPlayers.find((p) => p.pid === player.pid);
      if (!before || isWithdrawnPlayer(before)) continue;

      const activePlayers = nextPlayers
        .filter((p) => !isWithdrawnPlayer(p) && p.position >= 1 && p.position <= playerCount)
        .sort((a, b) => a.position - b.position);
      const activeIndex = activePlayers.findIndex((p) => p.pid === before.pid);
      if (activeIndex === -1 || activeIndex >= activePlayers.length - 1) continue;

      nextPlayers = movePlayerDownByPlaces(nextPlayers, before.pid, 3);
      const after = nextPlayers.find((p) => p.pid === before.pid);
      if (!after || after.position === before.position) continue;

      const message = `${before.name || "Player"} moved down 3 places for not playing a match between ${period.label}.`;
      adminLogs.push(
        makeAdminLog(before, message, {
          challengerStartPos: before.position,
          opponentStartPos: after.position,
        })
      );
    }

    if (adminLogs.length === 0) {
      return setError("No selected players could be dropped. They may already be at the bottom of the active ladder.");
    }

    const nextState = {
      ...state,
      [activeDivision]: {
        ...current,
        players: nextPlayers,
        matches: [...adminLogs, ...current.matches],
      },
    };

    setState(nextState);
    setDirty(true);
    try {
      await saveCloudState(pin, nextState, activeSeasonId);
      setDirty(false);
      setSelectedDropPids([]);
    } catch (e) {
      setError(String(e?.message || e || "Failed to save batch drop action to cloud."));
    }
  }

  async function actuallyWithdrawPlayer(pin) {
    setError("");
    if (locked) return setError("Locked: Admin unlock required.");
    const player = players.find((p) => p.pid === withdrawPid);
    if (!player) return setError("Choose a player to withdraw.");

    const withdrawnName = isWithdrawnPlayer(player) ? player.name : `W - ${player.name || "Withdrawn player"}`;
    const message = `${player.name || "Player"} withdrawn and moved to the bottom of the ladder.`;
    const moved = movePlayerToBottom(current.players, player.pid).map((p) => {
      if (p.pid !== player.pid) return p;
      return { ...p, withdrawn: true, name: withdrawnName };
    });

    const nextState = {
      ...state,
      [activeDivision]: {
        ...current,
        players: moved,
        matches: [makeAdminLog(player, message), ...current.matches],
      },
    };

    setState(nextState);
    setDirty(true);
    try {
      await saveCloudState(pin, nextState, activeSeasonId);
      setDirty(false);
      setWithdrawPid("");
    } catch (e) {
      setError(String(e?.message || e || "Failed to save withdraw action to cloud."));
    }
  }

  async function actuallyManualMovePlayer(pin) {
    setError("");
    if (locked) return setError("Locked: Admin unlock required.");

    const player = players.find((p) => p.pid === manualMovePid);
    if (!player) return setError("Choose a player to move.");
    if (isWithdrawnPlayer(player)) return setError("Withdrawn players are anchored at the bottom and can't be manually moved here.");

    const activeCount = current.players.filter((p) => !isWithdrawnPlayer(p) && String(p.name || "").trim().length > 0).length;
    const targetPosition = clamp(asNumber(manualMovePosition, 1), 1, Math.max(1, activeCount));
    const moved = moveActivePlayerToPosition(current.players, player.pid, targetPosition);

    const nextState = {
      ...state,
      [activeDivision]: {
        ...current,
        players: moved,
      },
    };

    setState(nextState);
    setDirty(true);

    try {
      await saveCloudState(pin, nextState, activeSeasonId);
      setDirty(false);
      setManualMovePid("");
      setManualMovePosition("1");
    } catch (e) {
      setError(String(e?.message || e || "Failed to save quiet manual move to cloud."));
    }
  }

  const pinTitle =
    pinPurpose === "unlock"
      ? "Admin unlock"
      : pinPurpose === "add"
      ? `Admin PIN required to add ${activeDivision === "mens" ? "Men's" : "Women's"} match`
      : pinPurpose === "delete"
      ? "Admin PIN required to delete match"
      : pinPurpose === "edit"
      ? "Admin PIN required to save edit"
      : pinPurpose === "drop3"
      ? "Admin PIN required to drop player"
      : pinPurpose === "withdraw"
      ? "Admin PIN required to withdraw player"
      : pinPurpose === "manualMove"
      ? "Admin PIN required for quiet manual move"
      : "Admin PIN required to save changes";

  const pinHint =
    pinPurpose === "unlock"
      ? "Unlock editing for this ladder season (viewers remain read-only)."
      : pinPurpose === "add"
      ? "PIN required right before saving this match."
      : pinPurpose === "delete"
      ? "PIN required before deleting a match."
      : pinPurpose === "edit"
      ? "PIN required to save an edit."
      : pinPurpose === "drop3"
      ? "PIN required to move this player down 3 places."
      : pinPurpose === "withdraw"
      ? "PIN required to withdraw this player."
      : pinPurpose === "manualMove"
      ? "PIN required to move this player without adding a log entry."
      : "PIN required to push your changes to the cloud.";

  const opponentLabel = useMemo(() => {
    const pos = clamp(asNumber(matchPos, 1), 1, playerCount);
    const p = players.find((x) => x.position === pos);
    const nm = p?.name?.trim();
    return nm ? `#${pos} (${nm})` : `#${pos}`;
  }, [matchPos, playerCount, players]);

  const divisionLabel = activeDivision === "mens" ? "Men's" : "Women's";
  const countdownText = (() => {
    if (!activeSeason?.start_date || !activeSeason?.end_date) return "Season dates not set";
    const start = new Date(`${activeSeason.start_date}T00:00:00`);
    const end = new Date(`${activeSeason.end_date}T23:59:59`);
    const now = new Date(nowTick);
    const fmt = (ms) => { const total = Math.max(0, Math.floor(ms / 1000)); const days = Math.floor(total / 86400); const hours = Math.floor((total % 86400) / 3600); const mins = Math.floor((total % 3600) / 60); return `${days}d ${hours}h ${mins}m`; };
    if (now < start) return `Starts in ${fmt(start - now)}`;
    if (now > end) return "Season finished";
    return `${fmt(end - now)} remaining`;
  })();

  async function exportXlsx() {
    try {
      const XLSX = await import("xlsx");
      const ladderRows = displayedPlayers.map((p) => ({ Position: isWithdrawnPlayer(p) ? "W" : p.position, Name: p.name, Played: p.matchesPlayed, Won: p.matchesWon, Lost: Math.max(0, p.matchesPlayed - p.matchesWon), "Sets Won": p.setsWon, "Sets Lost": p.setsLost, "Games Won": p.gamesWon, "Games Lost": p.gamesLost }));
      const historyRows = matchesView.map((m) => ({ Date: m.date, Challenger: m.p1Name, Opponent: m.p2Name, Winner: m.winnerName, Score: formatScore(m.score), "Position Played For": m.positionPlayedFor }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ladderRows), "Ladder"); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(historyRows), "Match History");
      XLSX.writeFile(wb, `Heron-${seasonLabel}-${divisionLabel}.xlsx`.replace(/[^a-z0-9_.-]+/gi, "-"));
    } catch (e) { setError(`Excel export failed: ${e?.message || e}`); }
  }

  async function exportPdf() {
    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      doc.setFontSize(18); doc.text(`Heron Tennis Ladder`, 14, 16); doc.setFontSize(12); doc.text(`${seasonLabel} • ${divisionLabel}`, 14, 24); doc.setFontSize(9); doc.text(`Exported ${new Date().toLocaleString("en-GB")}`, 14, 30);
      let y = 39; doc.setFont(undefined, "bold"); doc.text("Pos", 14, y); doc.text("Player", 28, y); doc.text("P", 118, y); doc.text("W", 132, y); doc.text("L", 146, y); doc.text("SD", 160, y); doc.text("GD", 178, y); doc.setFont(undefined, "normal"); y += 6;
      for (const p of displayedPlayers) { if (y > 282) { doc.addPage(); y = 16; } doc.text(String(isWithdrawnPlayer(p) ? "W" : p.position), 14, y); doc.text(String(p.name || "—").slice(0, 42), 28, y); doc.text(String(p.matchesPlayed || 0), 118, y); doc.text(String(p.matchesWon || 0), 132, y); doc.text(String(Math.max(0, (p.matchesPlayed || 0) - (p.matchesWon || 0))), 146, y); doc.text(String(p.setDiff || 0), 160, y); doc.text(String(p.gameDiff || 0), 178, y); y += 6; }
      doc.save(`Heron-${seasonLabel}-${divisionLabel}.pdf`.replace(/[^a-z0-9_.-]+/gi, "-"));
    } catch (e) { setError(`PDF export failed: ${e?.message || e}`); }
  }

  async function createSeason() {
    const name = window.prompt("New ladder season name", "August–November 2026"); if (!name) return;
    const startDate = window.prompt("Start date (YYYY-MM-DD)", "2026-08-01"); if (!startDate) return;
    const endDate = window.prompt("End date (YYYY-MM-DD)", "2026-11-30"); if (!endDate) return;
    const pin = window.prompt("Admin PIN"); if (!pin) return;
    try { const result = await adminAction(pin, "createSeason", { name, startDate, endDate }); const meta = await fetchSeasonMeta(); setSeasons(meta.seasons); setActiveSeasonId(result.season.id); }
    catch (e) { setError(String(e?.message || e)); }
  }

  async function editSeason() {
    if (!activeSeason) return;
    const name = window.prompt("Ladder season name", activeSeason.name || "");
    if (!name) return;
    const startDate = window.prompt("Start date (YYYY-MM-DD)", activeSeason.start_date || "");
    if (!startDate) return;
    const endDate = window.prompt("End date (YYYY-MM-DD)", activeSeason.end_date || "");
    if (!endDate) return;
    const pin = window.prompt("Admin PIN");
    if (!pin) return;
    try {
      await adminAction(pin, "updateSeason", { seasonId: activeSeasonId, name, startDate, endDate });
      const meta = await fetchSeasonMeta();
      setSeasons(meta.seasons);
    } catch (e) { setError(String(e?.message || e)); }
  }

  async function setPublicDefault() {
    const pin = window.prompt("Admin PIN"); if (!pin) return;
    try { await adminAction(pin, "setPublicDefault", { seasonId: activeSeasonId, division: activeDivision }); window.alert(`${seasonLabel} / ${divisionLabel} is now the guest default.`); }
    catch (e) { setError(String(e?.message || e)); }
  }

  useEffect(() => {
    if (!playerModalOpen || playerModalView !== "lifetime" || !playerModalPid) return undefined;
    const selected = players.find((x) => x.pid === playerModalPid);
    const playerName = String(selected?.name || "").trim();
    if (!playerName) return undefined;
    let alive = true;
    setLifetimeLoading(true);
    setLifetimeError("");
    fetchLifetimeStats(playerName, activeDivision, seasons)
      .then((data) => { if (alive) setLifetimeStats(data); })
      .catch((e) => { if (alive) setLifetimeError(String(e?.message || e || "Failed to load lifetime statistics.")); })
      .finally(() => { if (alive) setLifetimeLoading(false); });
    return () => { alive = false; };
  }, [playerModalOpen, playerModalView, playerModalPid, activeDivision, seasons, players]);

  return (
    <div className="app">
      <style>{css}</style>

      <Modal
        open={playerModalOpen}
        mobileFull={true}
        className="playerProfileModal"
        title={(() => {
          const p = players.find((x) => x.pid === playerModalPid);
          if (!p) return "Player results";
          const base = p.name?.trim() ? p.name : "Player";
          const inactive = p.position < 1 || p.position > playerCount;
          const withdrawn = isWithdrawnPlayer(p);
          return withdrawn ? `${base} — Player profile` : inactive ? `${base} (Inactive) — Player profile` : `${base} — Player profile`;
        })()}
        onClose={() => {
          setPlayerModalOpen(false);
          setPlayerModalPid(null);
          setPlayerModalView("recent");
          setLifetimeStats(null);
          setLifetimeError("");
        }}
        actions={<button className="btn" onClick={() => { setPlayerModalOpen(false); setPlayerModalPid(null); setPlayerModalView("recent"); setLifetimeStats(null); setLifetimeError(""); }}>Close</button>}
      >
        {(() => {
          const pid = playerModalPid;
          if (!pid) return <div className="hint">No player selected.</div>;
          const selectedPlayer = players.find((x) => x.pid === pid);
          const pnameBase = selectedPlayer?.name || "(Unknown)";
          const pname = selectedPlayer && !isWithdrawnPlayer(selectedPlayer) && (selectedPlayer.position < 1 || selectedPlayer.position > playerCount) ? `${pnameBase} (Inactive)` : pnameBase;
          const list = matchesView
            .filter((m) => m.challengerPid === pid || m.opponentPid === pid)
            .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));

          const currentMatches = list.filter((m) => !String(m.score || "").startsWith("ADMIN:"));
          const currentStats = (() => {
            let wins = 0, successfulChallenges = 0, successfulDefences = 0, bestStreak = 0, streak = 0;
            let challengeStreak = 0, bestChallengeStreak = 0, bagelSetsWon = 0;
            let setsWon = 0, setsLost = 0, gamesWon = 0, gamesLost = 0;
            let longestMatch = null, worstDefeat = null;
            const observedPositions = selectedPlayer?.position > 0 ? [selectedPlayer.position] : [];
            const h2h = new Map();
            const chronological = [...currentMatches].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
            for (const m of chronological) {
              const isChallenger = m.challengerPid === pid;
              const didWin = (m.winnerId === "p1" && isChallenger) || (m.winnerId === "p2" && !isChallenger);
              const ownStart = isChallenger ? asNumber(m.challengerStartPos, 0) : asNumber(m.opponentStartPos, 0);
              if (ownStart > 0) observedPositions.push(ownStart);
              if (didWin) {
                wins += 1; streak += 1; bestStreak = Math.max(bestStreak, streak);
                if (isChallenger) { successfulChallenges += 1; challengeStreak += 1; bestChallengeStreak = Math.max(bestChallengeStreak, challengeStreak); }
                else { successfulDefences += 1; challengeStreak = 0; }
              } else {
                streak = 0;
                challengeStreak = 0;
                if (!isChallenger) {
                  const gap = Math.max(0, asNumber(m.challengerStartPos, 0) - asNumber(m.opponentStartPos, 0));
                  const candidate = { gap, opponent: m.p1Name || "Unknown", score: m.score, date: m.date, from: asNumber(m.opponentStartPos, 0), challengerFrom: asNumber(m.challengerStartPos, 0), seasonName: seasonLabel };
                  if (!worstDefeat || gap > worstDefeat.gap || (gap === worstDefeat.gap && candidate.from < worstDefeat.from)) worstDefeat = candidate;
                }
              }
              const scoreInfo = scoreDetailsForPlayer(m.score, isChallenger);
              bagelSetsWon += scoreInfo.bagelsWon;
              const matchCandidate = { opponent: isChallenger ? m.p2Name : m.p1Name, score: m.score, date: m.date, seasonName: seasonLabel, totalGames: scoreInfo.totalGames, didWin };
              if (!longestMatch || matchCandidate.totalGames > longestMatch.totalGames) longestMatch = matchCandidate;
              const parsed = parseScore(m.score);
              if (parsed.valid) {
                const totals = computeFromSets(parsed.sets);
                setsWon += isChallenger ? totals.p1Sets : totals.p2Sets;
                setsLost += isChallenger ? totals.p2Sets : totals.p1Sets;
                gamesWon += isChallenger ? totals.p1Games : totals.p2Games;
                gamesLost += isChallenger ? totals.p2Games : totals.p1Games;
              }
              const opponentName = isChallenger ? m.p2Name : m.p1Name;
              const key = String(opponentName || "Unknown").toLowerCase();
              const hr = h2h.get(key) || { name: opponentName || "Unknown", played: 0, wins: 0 };
              hr.played += 1; if (didWin) hr.wins += 1; h2h.set(key, hr);
            }
            const played = currentMatches.length;
            const matchupRows = [...h2h.values()].map((x) => ({ ...x, losses: x.played - x.wins, winPct: x.played ? Math.round((x.wins / x.played) * 100) : 0 }));
            const bestVs = [...matchupRows].sort((a,b) => b.winPct-a.winPct || b.played-a.played || b.wins-a.wins)[0] || null;
            const worstVs = [...matchupRows].sort((a,b) => a.winPct-b.winPct || b.played-a.played || b.losses-a.losses)[0] || null;
            const mostFrequentOpponent = [...matchupRows].sort((a,b) => b.played-a.played || a.name.localeCompare(b.name))[0] || null;
            const matchupSummary = summarizeMatchups(currentMatches, pid);
            const biggestWin = matchupSummary.biggestUpset ? { ...matchupSummary.biggestUpset, seasonName: seasonLabel } : null;
            const oneStats = computeNumberOneStats(players, matches, activeSeason, nowTick).get(pid) || { daysAtOne: 0, numberOneDefences: 0 };
            return {
              played, wins, losses: played - wins, winPct: played ? Math.round((wins / played) * 100) : 0,
              successfulChallenges, successfulDefences, bestStreak, bestChallengeStreak, bagelSetsWon, longestMatch, worstDefeat,
              daysAtOne: oneStats.daysAtOne, numberOneDefences: oneStats.numberOneDefences,
              highestPosition: observedPositions.length ? Math.min(...observedPositions) : null,
              lowestPosition: observedPositions.length ? Math.max(...observedPositions) : null,
              mostFrequentOpponent, biggestUpset: biggestWin, bestVs, worstVs,
              setsWon, setsLost, gamesWon, gamesLost,
              headToHead: matchupRows.sort((a,b) => b.played-a.played || a.name.localeCompare(b.name))
            };
          })();

          return (
            <div className="playerProfile">
              <div className="segControl playerProfileToggle" role="tablist" aria-label="Player profile view">
                <button className={playerModalView === "recent" ? "segBtn active" : "segBtn"} onClick={() => setPlayerModalView("recent")}>Recent Matches</button>
                <button className={playerModalView === "current" ? "segBtn active" : "segBtn"} onClick={() => setPlayerModalView("current")}>Current Season Stats</button>
                <button className={playerModalView === "lifetime" ? "segBtn active" : "segBtn"} onClick={() => setPlayerModalView("lifetime")}>Lifetime Stats</button>
              </div>

              {playerModalView === "recent" ? (
                list.length === 0 ? <div className="hint">No matches logged for this player yet.</div> : (
                  <div className="playerMatchList mobileSpacious">
                    {list.map((m) => {
                      const isChallenger = m.challengerPid === pid;
                      const opponentName = isChallenger ? m.p2Name : m.p1Name;
                      const didWin = (m.winnerId === "p1" && isChallenger) || (m.winnerId === "p2" && !isChallenger);
                      return (
                        <div key={m.id} className="playerMatchRow roomy">
                          <div className="playerMatchTop"><div className="mono">{m.date}</div><div className={didWin ? "pillWin" : "pillLoss"}>{didWin ? "WIN" : "LOSS"}</div></div>
                          <div className="playerMatchMid stackedMobile">
                            <div><div className="playerMatchTitle">{pname} vs {opponentName}</div><div className="hint">{isChallenger ? `Challenging for Position #${m.positionPlayedFor}` : `Defending Position #${m.positionPlayedFor}`}{m.ladderMoveApplied ? " • Ladder moved" : ""}</div></div>
                            <div className="mono playerMatchScore">{formatScoreForPlayer(m.score, isChallenger)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : playerModalView === "current" ? (
                <div className="lifetimeStats currentSeasonStats">
                  <div className="lifetimeKpis">
                    <div className="analyticsKpi"><div className="analyticsKpiLabel">Season record</div><div className="analyticsKpiValue">{currentStats.wins}–{currentStats.losses}</div><div className="analyticsKpiSub">{currentStats.winPct}% win rate</div></div>
                    <div className="analyticsKpi"><div className="analyticsKpiLabel">Matches played</div><div className="analyticsKpiValue">{currentStats.played}</div><div className="analyticsKpiSub">{seasonLabel}</div></div>
                    <div className="analyticsKpi"><div className="analyticsKpiLabel">Successful challenges</div><div className="analyticsKpiValue">{currentStats.successfulChallenges}</div></div>
                    <div className="analyticsKpi"><div className="analyticsKpiLabel">Successful defences</div><div className="analyticsKpiValue">{currentStats.successfulDefences}</div></div>
                    <div className="analyticsKpi"><div className="analyticsKpiLabel">Best winning streak</div><div className="analyticsKpiValue">{currentStats.bestStreak}</div></div>
                    <div className="analyticsKpi"><div className="analyticsKpiLabel">Current position</div><div className="analyticsKpiValue">{selectedPlayer?.position >= 1 && selectedPlayer?.position <= playerCount ? `#${selectedPlayer.position}` : "—"}</div></div>
                    <div className="analyticsKpi"><div className="analyticsKpiLabel">Days at #1</div><div className="analyticsKpiValue">{currentStats.daysAtOne}</div><div className="analyticsKpiSub">{currentStats.numberOneDefences} defence{currentStats.numberOneDefences === 1 ? "" : "s"}</div></div>
                    <div className="analyticsKpi recordKpi"><div className="analyticsKpiLabel">Biggest win</div>{currentStats.biggestUpset ? <><div className="analyticsKpiValue smallKpiValue">#{currentStats.biggestUpset.from} → #{currentStats.biggestUpset.to}</div><div className="analyticsKpiSub">+{currentStats.biggestUpset.gap} places • vs {currentStats.biggestUpset.opponent}</div><div className="recordMeta">{formatProfileDate(currentStats.biggestUpset.date)} • {currentStats.biggestUpset.seasonName}</div><div className="recordScore">{currentStats.biggestUpset.score}</div></> : <div className="analyticsKpiSub">No successful challenge yet</div>}</div>
                  </div>
                  <div className="analyticsGrid">
                    <div className="analyticsBox"><div className="analyticsBoxTitle">Season totals</div><div className="careerTotals"><div>Sets <strong>{currentStats.setsWon}–{currentStats.setsLost}</strong></div><div>Games <strong>{currentStats.gamesWon}–{currentStats.gamesLost}</strong></div><div>Set diff <strong>{currentStats.setsWon-currentStats.setsLost >= 0 ? "+" : ""}{currentStats.setsWon-currentStats.setsLost}</strong></div><div>Game diff <strong>{currentStats.gamesWon-currentStats.gamesLost >= 0 ? "+" : ""}{currentStats.gamesWon-currentStats.gamesLost}</strong></div></div></div>
                    
                  </div>
                  <div className="analyticsGrid"><div className="analyticsBox"><div className="analyticsBoxTitle">Best record vs</div><div className="profileMatchup">{currentStats.bestVs ? <><strong>{currentStats.bestVs.name}</strong><span>{currentStats.bestVs.wins}–{currentStats.bestVs.losses} ({currentStats.bestVs.winPct}%)</span></> : "—"}</div></div><div className="analyticsBox"><div className="analyticsBoxTitle">Worst record vs</div><div className="profileMatchup">{currentStats.worstVs ? <><strong>{currentStats.worstVs.name}</strong><span>{currentStats.worstVs.wins}–{currentStats.worstVs.losses} ({currentStats.worstVs.winPct}%)</span></> : "—"}</div></div></div>
                  <div className="analyticsBox recordsBox">
                    <div className="analyticsBoxTitle">Season records</div>
                    <div className="recordsGrid">
                      <div className="recordItem"><span>Highest ranking</span><strong>{currentStats.highestPosition ? `#${currentStats.highestPosition}` : "—"}</strong></div>
                      <div className="recordItem"><span>Lowest ranking</span><strong>{currentStats.lowestPosition ? `#${currentStats.lowestPosition}` : "—"}</strong></div>
                      <div className="recordItem"><span>Most frequent opponent</span><strong>{currentStats.mostFrequentOpponent ? `${currentStats.mostFrequentOpponent.name} (${currentStats.mostFrequentOpponent.played})` : "—"}</strong></div>
                      <div className="recordItem"><span>Best challenge streak</span><strong>{currentStats.bestChallengeStreak}</strong></div>
                      <div className="recordItem"><span>6–0 sets won</span><strong>{currentStats.bagelSetsWon}</strong></div>
                      <div className="recordItem"><span>Longest match (by games)</span><strong>{currentStats.longestMatch ? `${currentStats.longestMatch.totalGames} vs ${currentStats.longestMatch.opponent}` : "—"}</strong>{currentStats.longestMatch ? <small>{formatProfileDate(currentStats.longestMatch.date)} • {currentStats.longestMatch.score}</small> : null}</div>
                      <div className="recordItem"><span>Worst defeat</span><strong>{currentStats.worstDefeat ? `#${currentStats.worstDefeat.challengerFrom} beat #${currentStats.worstDefeat.from}` : "—"}</strong>{currentStats.worstDefeat ? <small>{formatProfileDate(currentStats.worstDefeat.date)} • vs {currentStats.worstDefeat.opponent}</small> : null}</div>
                    </div>
                  </div>
                  <div className="analyticsBox analyticsTableBox"><div className="analyticsBoxTitle">Current-season head to head</div>{currentStats.headToHead.length ? <div className="tableWrap"><table className="table lifetimeTable"><thead><tr><th>Opponent</th><th>Meetings</th><th>Record</th><th>Win %</th></tr></thead><tbody>{currentStats.headToHead.map((x) => <tr key={x.name.toLowerCase()}><td><strong>{x.name}</strong></td><td>{x.played}</td><td>{x.wins}–{x.played-x.wins}</td><td>{x.played ? Math.round((x.wins/x.played)*100) : 0}%</td></tr>)}</tbody></table></div> : <div className="hint analyticsEmpty">No head-to-head history this season.</div>}</div>
                </div>
              ) : lifetimeLoading ? <div className="hint lifetimeStatus">Loading lifetime statistics…</div>
                : lifetimeError ? <div className="errorBox">{lifetimeError}</div>
                : !lifetimeStats ? <div className="hint lifetimeStatus">No lifetime statistics available.</div>
                : (
                  <div className="lifetimeStats">
                    <div className="lifetimeKpis">
                      <div className="analyticsKpi"><div className="analyticsKpiLabel">Career record</div><div className="analyticsKpiValue">{lifetimeStats.wins}–{lifetimeStats.losses}</div><div className="analyticsKpiSub">{lifetimeStats.winPct}% win rate</div></div>
                      <div className="analyticsKpi"><div className="analyticsKpiLabel">Seasons played</div><div className="analyticsKpiValue">{lifetimeStats.seasonsPlayed}</div><div className="analyticsKpiSub">{lifetimeStats.played} matches</div></div>
                      <div className="analyticsKpi"><div className="analyticsKpiLabel">Successful challenges</div><div className="analyticsKpiValue">{lifetimeStats.successfulChallenges}</div></div>
                      <div className="analyticsKpi"><div className="analyticsKpiLabel">Successful defences</div><div className="analyticsKpiValue">{lifetimeStats.successfulDefences}</div></div>
                      <div className="analyticsKpi"><div className="analyticsKpiLabel">Best winning streak</div><div className="analyticsKpiValue">{lifetimeStats.bestStreak}</div></div>
                      <div className="analyticsKpi"><div className="analyticsKpiLabel">Highest position</div><div className="analyticsKpiValue">{lifetimeStats.highestPosition ? `#${lifetimeStats.highestPosition}` : "—"}</div></div>
                      <div className="analyticsKpi"><div className="analyticsKpiLabel">Days at #1</div><div className="analyticsKpiValue">{lifetimeStats.daysAtOne}</div><div className="analyticsKpiSub">{lifetimeStats.numberOneDefences} defence{lifetimeStats.numberOneDefences === 1 ? "" : "s"}</div></div>
                      <div className="analyticsKpi recordKpi"><div className="analyticsKpiLabel">Biggest win</div>{lifetimeStats.biggestUpset ? <><div className="analyticsKpiValue smallKpiValue">#{lifetimeStats.biggestUpset.from} → #{lifetimeStats.biggestUpset.to}</div><div className="analyticsKpiSub">+{lifetimeStats.biggestUpset.gap} places • vs {lifetimeStats.biggestUpset.opponent}</div><div className="recordMeta">{formatProfileDate(lifetimeStats.biggestUpset.date)} • {lifetimeStats.biggestUpset.seasonName}</div><div className="recordScore">{lifetimeStats.biggestUpset.score}</div></> : <div className="analyticsKpiSub">No successful challenge yet</div>}</div>
                    </div>

                    <div className="analyticsGrid">
                      <div className="analyticsBox"><div className="analyticsBoxTitle">Career totals</div><div className="careerTotals"><div>Sets <strong>{lifetimeStats.setsWon}–{lifetimeStats.setsLost}</strong></div><div>Games <strong>{lifetimeStats.gamesWon}–{lifetimeStats.gamesLost}</strong></div><div>Set diff <strong>{lifetimeStats.setsWon - lifetimeStats.setsLost >= 0 ? "+" : ""}{lifetimeStats.setsWon - lifetimeStats.setsLost}</strong></div><div>Game diff <strong>{lifetimeStats.gamesWon - lifetimeStats.gamesLost >= 0 ? "+" : ""}{lifetimeStats.gamesWon - lifetimeStats.gamesLost}</strong></div></div></div>
                      
                    </div>

                    <div className="analyticsGrid"><div className="analyticsBox"><div className="analyticsBoxTitle">Best career record vs</div><div className="profileMatchup">{lifetimeStats.bestVs ? <><strong>{lifetimeStats.bestVs.name}</strong><span>{lifetimeStats.bestVs.wins}–{lifetimeStats.bestVs.losses} ({lifetimeStats.bestVs.winPct}%)</span></> : "—"}</div></div><div className="analyticsBox"><div className="analyticsBoxTitle">Worst career record vs</div><div className="profileMatchup">{lifetimeStats.worstVs ? <><strong>{lifetimeStats.worstVs.name}</strong><span>{lifetimeStats.worstVs.wins}–{lifetimeStats.worstVs.losses} ({lifetimeStats.worstVs.winPct}%)</span></> : "—"}</div></div></div>
                    <div className="analyticsBox recordsBox">
                      <div className="analyticsBoxTitle">Career records</div>
                      <div className="recordsGrid">
                        <div className="recordItem"><span>Highest ranking</span><strong>{lifetimeStats.highestPosition ? `#${lifetimeStats.highestPosition}` : "—"}</strong></div>
                        <div className="recordItem"><span>Lowest ranking</span><strong>{lifetimeStats.lowestPosition ? `#${lifetimeStats.lowestPosition}` : "—"}</strong></div>
                        <div className="recordItem"><span>Most frequent opponent</span><strong>{lifetimeStats.mostFrequentOpponent ? `${lifetimeStats.mostFrequentOpponent.name} (${lifetimeStats.mostFrequentOpponent.played})` : "—"}</strong></div>
                        <div className="recordItem"><span>Best challenge streak</span><strong>{lifetimeStats.bestChallengeStreak}</strong></div>
                        <div className="recordItem"><span>6–0 sets won</span><strong>{lifetimeStats.bagelSetsWon}</strong></div>
                        <div className="recordItem"><span>Longest match (by games)</span><strong>{lifetimeStats.longestMatch ? `${lifetimeStats.longestMatch.totalGames} vs ${lifetimeStats.longestMatch.opponent}` : "—"}</strong>{lifetimeStats.longestMatch ? <small>{formatProfileDate(lifetimeStats.longestMatch.date)} • {lifetimeStats.longestMatch.seasonName} • {lifetimeStats.longestMatch.score}</small> : null}</div>
                        <div className="recordItem"><span>Worst defeat</span><strong>{lifetimeStats.worstDefeat ? `#${lifetimeStats.worstDefeat.challengerFrom} beat #${lifetimeStats.worstDefeat.from}` : "—"}</strong>{lifetimeStats.worstDefeat ? <small>{formatProfileDate(lifetimeStats.worstDefeat.date)} • {lifetimeStats.worstDefeat.seasonName} • vs {lifetimeStats.worstDefeat.opponent}</small> : null}</div>
                      </div>
                    </div>
                    <div className="analyticsBox analyticsTableBox"><div className="analyticsBoxTitle">Season by season</div><div className="tableWrap"><table className="table lifetimeTable"><thead><tr><th>Season</th><th>Played</th><th>Record</th><th>Win %</th></tr></thead><tbody>{lifetimeStats.seasons.map((x) => <tr key={x.seasonId}><td><strong>{x.name}</strong></td><td>{x.played}</td><td>{x.wins}–{x.losses}</td><td>{x.winPct}%</td></tr>)}</tbody></table></div></div>

                    <div className="analyticsBox analyticsTableBox"><div className="analyticsBoxTitle">Lifetime head to head</div>{lifetimeStats.headToHead.length ? <div className="tableWrap"><table className="table lifetimeTable"><thead><tr><th>Opponent</th><th>Meetings</th><th>Record</th></tr></thead><tbody>{lifetimeStats.headToHead.map((x) => <tr key={x.name.toLowerCase()}><td><strong>{x.name}</strong></td><td>{x.played}</td><td>{x.wins}–{x.losses}</td></tr>)}</tbody></table></div> : <div className="hint analyticsEmpty">No head-to-head history.</div>}</div>
                  </div>
                )}
            </div>
          );
        })()}
      </Modal>

      <Modal open={matchAddedOpen} title="Match added" onClose={() => setMatchAddedOpen(false)} actions={<button className="btn" onClick={() => setMatchAddedOpen(false)}>OK</button>}>
        <div>Saved successfully.</div>
      </Modal>

      <Modal open={editOpen} mobileFull={true} title="Edit match" onClose={() => { setEditOpen(false); setEditId(null); setEditError(""); }} actions={<><button className="btnGhost" onClick={() => { setEditOpen(false); setEditId(null); setEditError(""); }}>Cancel</button><button className="btn" onClick={requestSaveEdit}>Save</button></>}>
        {editError ? <div className="errorBox">{editError}</div> : null}
        <div className="formGrid mobileSingle" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginTop: 2 }}>
          <div>
            <div className="label">Date</div>
            <input className="textInput" type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
          </div>
          <div>
            <div className="label">Winner</div>
            <select className="textInput" value={editWinner} onChange={(e) => setEditWinner(e.target.value)}>
              <option value="p1">Challenger</option>
              <option value="p2">Opponent</option>
            </select>
          </div>
          <div>
            <div className="label">Score (Challenger perspective)</div>
            <input className="textInput" value={editScore} onChange={(e) => setEditScore(e.target.value)} placeholder="e.g. 6-4 3-6 10-8" />
          </div>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>Saving an edit will recalculate stats and ladder moves.</div>
      </Modal>

      <Modal open={pinOpen} title={pinTitle} onClose={closePin} actions={<><button className="btnGhost" onClick={closePin}>Cancel</button><button className="btn" onClick={submitPin}>{pinPurpose === "unlock" ? "Unlock" : "Continue"}</button></>}>
        <label className="label">Enter PIN</label>
        <input ref={pinRef} className="textInput" type="password" value={pinValue} onChange={(e) => setPinValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitPin(); }} placeholder="••••" />
        {pinError ? <div className="error">{pinError}</div> : null}
        <div className="hint">{pinHint}</div>
      </Modal>

      <Modal open={deleteConfirmOpen} title="Are you sure?" onClose={() => setDeleteConfirmOpen(false)} actions={<><button className="btnGhost" onClick={() => setDeleteConfirmOpen(false)}>No</button><button className="btnDanger" onClick={deleteMatchConfirmed}>Yes, delete</button></>}>
        <div className="hint">This removes the match and reverses its stats/ladder movement.</div>
      </Modal>

      <div className="container">
        <div className="card stickyControlsCard" style={{ marginBottom: 14 }}>
          <div className="cardHeader mobileStickyHeader">
            <div>
              <div className="title">Heron Tennis Ladder</div>
              <div className="seasonTimer">{countdownText}</div>
              <div className="subtitle">
                {seasonLabel} • {divisionLabel} ladder • {playerCount} players • Cloud synced.
                {cloudLoading ? " • Loading…" : ""} • Build analytics-v2
              </div>
              {cloudError ? <div className="error">Cloud error: {cloudError}</div> : null}
              {!supabase ? <div className="error">Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY</div> : null}
            </div>
            <div className="actions mobileActions">
              <select className="textInput seasonSelect" value={activeSeasonId} onChange={(e) => setActiveSeasonId(e.target.value)}>
                {seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}
              </select>
              <div className="segControl fullOnMobile">
                {DIVISIONS.map((d) => (
                  <button key={d.key} className={activeDivision === d.key ? "segBtn active" : "segBtn"} onClick={() => setActiveDivision(d.key)}>
                    {d.label}
                  </button>
                ))}
              </div>
              <button className="btnGhost" onClick={exportPdf}>Export PDF</button>
              <button className="btnGhost" onClick={exportXlsx}>Export Excel</button>
              <button className={locked ? "btn" : "btnGhost"} onClick={() => (locked ? openPin("unlock") : setLocked(true))}>
                {locked ? "Locked — Admin unlock" : "Unlocked — Lock"}
              </button>
              <button className="btnGhost" onClick={() => { setSortKey("position"); setSortDir("asc"); }}>Reset sort</button>
              <button className={dirty && !locked ? "btn" : "btnGhost"} disabled={locked || !dirty} onClick={() => openPin("save")}>Save changes</button>
            </div>
          </div>

          <div className="mobileOnly cardBody mobileToolbarWrap">
            <div className="quickNav">
              <button className="quickNavBtn" onClick={() => scrollToRef(liveRef)}>Live ranking</button>
              <button className="quickNavBtn" onClick={() => scrollToRef(ladderRef)}>Ladder</button>
              <button className="quickNavBtn" onClick={() => scrollToRef(addMatchRef)}>Add match</button>
              <button className="quickNavBtn" onClick={() => scrollToRef(historyRef)}>Match history</button>
            </div>
            <MobileSummary divisionLabel={divisionLabel} playerCount={playerCount} totalMatches={matches.length} top3={leaderboardTop3} />
          </div>

          <div className="cardBody" style={{ paddingTop: 12 }} ref={liveRef}>
            <div className="liveHeader">
              <div>
                <div className="cardTitle">Live ranking</div>
                <div className="hint">Top 3 • {divisionLabel}</div>
              </div>
            </div>
            {leaderboardTop3.length === 0 ? <div className="hint">Add names + matches to populate.</div> : <div className="leaderRowGrid podiumGrid">{leaderboardTop3.map((p, i) => <LeaderCard key={p.pid} medal={["🥇","🥈","🥉"][i]} rank={i + 1} p={p} onClick={() => { setPlayerModalPid(p.pid); setPlayerModalOpen(true); }} form={matchesView.filter((m) => m.challengerPid === p.pid || m.opponentPid === p.pid).slice(0,5).map((m) => ((m.winnerId === "p1" && m.challengerPid === p.pid) || (m.winnerId === "p2" && m.opponentPid === p.pid)) ? "W" : "L")} />)}</div>}
            <div className="seasonHighlightsBanner" aria-label="Season highlights">
              <div className="seasonHighlightItem">
                <span className="seasonHighlightLabel">🚀 Highest Climbers</span>
                <strong>
                  {topClimbers.length
                    ? topClimbers
                        .map((group) => `${group.rank}. ${group.players.map((p) => p.name).join(" / ")} (+${group.progress})`)
                        .join(" • ")
                    : "—"}
                </strong>
                <span className="seasonHighlightValue">Top 3 upward progression</span>
              </div>
              <div className="seasonHighlightDivider" aria-hidden="true" />
              <div className="seasonHighlightItem">
                <span className="seasonHighlightLabel">🎾 Most Active</span>
                <strong>{seasonBannerStats.mostActive.length ? seasonBannerStats.mostActive.map((p) => p.name).join(" • ") : "—"}</strong>
                <span className="seasonHighlightValue">{seasonBannerStats.mostActive.length ? `${seasonBannerStats.mostActiveMatches} matches` : "—"}</span>
              </div>
              <div className="seasonHighlightDivider" aria-hidden="true" />
              <div className="seasonHighlightItem">
                <span className="seasonHighlightLabel">📊 Matches This Season</span>
                <strong>{seasonBannerStats.totalMatches}</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="card" ref={ladderRef}>
          <div className="cardHeader ladderViewHeader">
            <div>
              <div className="cardTitle">{ladderView === "live" ? "Live Table" : "Statistics and Analytics"}</div>
              <div className="hint">{ladderView === "live" ? "Locked = nothing editable." : `${divisionLabel} • ${seasonLabel}`}</div>
            </div>
            <div className="segControl ladderViewToggle" aria-label="Choose ladder view">
              <button className={ladderView === "live" ? "segBtn active" : "segBtn"} onClick={() => setLadderView("live")}>Live Table</button>
              <button className={ladderView === "analytics" ? "segBtn active" : "segBtn"} onClick={() => setLadderView("analytics")}>Statistics and Analytics</button>
            </div>
          </div>
          <div className="cardBody">
            {ladderView === "analytics" ? (
              <AnalyticsPanel analytics={analytics} divisionLabel={divisionLabel} seasonLabel={seasonLabel} />
            ) : (
              <>
                <div className="mobileOnly swipeHint">Swipe sideways to view all stats →</div>
                <div className="tableWrap mobileTableWrap">
                  <table className="table ladderTable">
                    <thead>
                      <tr>
                        {[...COLS, ...ladderMonthColumns].map((c) => <th key={c.key}><button className="thBtn" onClick={() => toggleSort(c.key)}>{c.label}{sortIndicator(c.key)}</button></th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {displayedPlayers.map((p) => (
                        <tr key={p.pid} className={isWithdrawnPlayer(p) ? "withdrawnRow" : ""} style={ladderRowStyle(p.position)}>
                          <td className="posCell">{isWithdrawnPlayer(p) ? "W" : p.position}</td>
                          <td>
                            {locked ? (
                              <button type="button" className="nameBtn" style={latestResultStyle(p.pid)} onClick={() => { setPlayerModalPid(p.pid); setPlayerModalOpen(true); }} title="Tap to view results">{p.name || "—"}</button>
                            ) : (
                              <input className="textInput" value={p.name} placeholder="Player name" onChange={(e) => updatePlayer(p.pid, "name", e.target.value)} />
                            )}
                          </td>
                          <td className={p.ladderProgress > 0 ? "progressPositive" : p.ladderProgress < 0 ? "progressNegative" : "progressNeutral"}>{p.ladderProgress > 0 ? `+${p.ladderProgress}` : p.ladderProgress}</td>
                          <td><StatCell locked={locked} value={p.matchesPlayed} onChange={(v) => updatePlayer(p.pid, "matchesPlayed", v)} /></td>
                          <td><StatCell locked={locked} value={p.matchesWon} onChange={(v) => updatePlayer(p.pid, "matchesWon", v)} /></td>
                          <td><StatCell locked={locked} value={p.setsWon} onChange={(v) => updatePlayer(p.pid, "setsWon", v)} /></td>
                          <td><StatCell locked={locked} value={p.setsLost} onChange={(v) => updatePlayer(p.pid, "setsLost", v)} /></td>
                          <td className="diff">{p.setDiff}</td>
                          <td><StatCell locked={locked} value={p.gamesWon} onChange={(v) => updatePlayer(p.pid, "gamesWon", v)} /></td>
                          <td><StatCell locked={locked} value={p.gamesLost} onChange={(v) => updatePlayer(p.pid, "gamesLost", v)} /></td>
                          <td className="diff">{p.gameDiff}</td>
                          {ladderMonthColumns.map((c) => <td key={c.key}><div className="numText">{monthlyPlayedByPid.get(p.pid)?.get(c.key) || 0}</div></td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="card" style={{ marginTop: 14 }} ref={addMatchRef}>
          <div className="cardHeader"><div><div className="cardTitle">Add Match</div><div className="hint">{divisionLabel} ladder • Add/Delete/Edit require PIN.</div></div></div>
          <div className="cardBody">
            {error ? <div className="errorBox">{error}</div> : null}
            <div className="matchEntryLayout scorecardEntryLayout">
              <div className="matchPlayersPanel scorecardPlayersPanel">
                <div className="scorecardHeaderRow">
                  <div className="matchPanelHeading">Players</div>
                  <div className="scoreSetHeadings" aria-hidden="true"><span>Set 1</span><span>Set 2</span><span>Set 3</span></div>
                </div>

                <div className="matchPlayerRow scorecardPlayerRow">
                  <div className="matchPlayerNumber">1</div>
                  <div className="matchPlayerField">
                    <div className="label">Challenger</div>
                    <select
                      className="textInput tallOnMobile matchPlayerSelect"
                      value={challengerPid}
                      onChange={(e) => setChallengerPid(e.target.value)}
                      disabled={locked}
                    >
                      <option value="">Select challenger…</option>
                      {selectablePlayers
                        .filter((p) => p.pid !== opponent?.pid)
                        .map((p) => <option key={p.pid} value={p.pid}>#{p.position} — {p.name}</option>)}
                    </select>
                  </div>
                  <div className="scoreCellGroup">
                    {[0, 1, 2].map((col) => (
                      <input key={col} className="scoreCell" type="text" inputMode="numeric" aria-label={`Challenger set ${col + 1}`} value={scoreCells[col]} onChange={(e) => updateScoreCell(0, col, e.target.value)} disabled={locked} />
                    ))}
                  </div>
                </div>

                <div className="matchPlayerRow scorecardPlayerRow">
                  <div className="matchPlayerNumber">2</div>
                  <div className="matchPlayerField">
                    <div className="label">Opponent</div>
                    <select
                      className="textInput tallOnMobile matchPlayerSelect"
                      value={opponent?.pid || ""}
                      onChange={(e) => {
                        const selected = players.find((p) => p.pid === e.target.value);
                        if (selected) setMatchPos(String(selected.position));
                      }}
                      disabled={locked}
                    >
                      {selectablePlayers
                        .filter((p) => p.pid !== challengerPid)
                        .map((p) => <option key={p.pid} value={p.pid}>#{p.position} — {p.name}</option>)}
                    </select>
                  </div>
                  <div className="scoreCellGroup">
                    {[0, 1, 2].map((col) => (
                      <input key={col} className="scoreCell" type="text" inputMode="numeric" aria-label={`Opponent set ${col + 1}`} value={scoreCells[3 + col]} onChange={(e) => updateScoreCell(1, col, e.target.value)} disabled={locked} />
                    ))}
                  </div>
                </div>

                <div className="matchPositionNote">
                  Playing for <strong>Position #{opponent?.position || matchPos}</strong>{opponent?.name?.trim() ? ` • currently ${opponent.name}` : ""}
                </div>
                <div className="hint scorecardHint">Leave Set 3 blank for a straight-sets result. A match tie-break can be entered normally, e.g. 10–8.</div>
              </div>

              <div className="matchDetailsPanel">
                <div className="matchPanelHeading">Match details</div>
                <div className="matchDetailsGrid">
                  <div>
                    <div className="label">Date</div>
                    <input
                      className="textInput tallOnMobile"
                      type="date"
                      value={matchDate}
                      onChange={(e) => {
                        matchDateManuallyChangedRef.current = true;
                        setMatchDate(e.target.value);
                      }}
                      disabled={locked}
                    />
                  </div>
                  <div>
                    <div className="label">Winner</div>
                    <div
                      className={`textInput tallOnMobile autoWinnerField${scoreOutcome.valid ? " resolved" : ""}`}
                      aria-live="polite"
                      aria-label="Calculated match winner"
                    >
                      {scoreOutcome.label}
                    </div>
                  </div>
                </div>
                <button className="btn fullWidthOnMobile matchSubmitBtn" onClick={requestAddMatch} disabled={locked}>Add match</button>
              </div>
            </div>

            {locked ? <div className="hint" style={{ marginTop: 10 }}>Locked: nothing is editable. Admin unlock to enter results.</div> : null}

            <div className="sep" />
            <div className="cardTitle" style={{ marginBottom: 8 }} ref={historyRef}>Completed matches</div>
            <div className="mobileOnly collapsibleWrap">
              <button className="collapseBtn" onClick={() => setMobileHistoryOpen((v) => !v)}>
                {mobileHistoryOpen ? "Hide match history" : "Show match history"}
              </button>
            </div>
            <div className={mobileHistoryOpen ? "sectionOpen" : "sectionClosedMobileOnly"}>
              {matchesView.length === 0 ? <div className="hint">No matches logged yet.</div> : (
                <div className="tableWrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date</th><th>Played for</th><th>Challenger</th><th>Opponent</th><th>Winner</th><th>Score</th>{!locked ? <th style={{ textAlign: "right" }}>Actions</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {matchesView.map((m) => (
                        <tr key={m.id}>
                          <td className="mono">{m.date}</td>
                          <td>#{m.positionPlayedFor}</td>
                          <td>{String(m.score || "").startsWith("ADMIN:") ? m.p1Name : m.p1Name}</td>
                          <td>{String(m.score || "").startsWith("ADMIN:") ? "—" : m.p2Name}</td>
                          <td>{String(m.score || "").startsWith("ADMIN:") ? "Admin action" : m.winnerName}</td>
                          <td className="mono">{String(m.score || "").startsWith("ADMIN:") ? String(m.score).replace("ADMIN: ", "") : formatScore(m.score)}</td>
                          {!locked ? (
                            <td style={{ textAlign: "right" }}>
                              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                                <button className="btnGhost" onClick={() => openEditMatch(m)}>Edit</button>
                                <button className="btnDanger" onClick={() => requestDeleteMatch(m.id)}>Delete</button>
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {!locked ? (
              <>
                <div className="sep" />

                <div className="managementBox manualMoveBox">
                  <div className="cardTitle">Quiet manual move</div>
                  <div className="hint">Move a player directly to a chosen active position. This is PIN-protected and does not add anything to Matches / Actions / Logs.</div>
                  <div className="formGrid mobileSingle" style={{ gridTemplateColumns: "1fr 1fr auto", alignItems: "end" }}>
                    <div>
                      <div className="label">Player to move</div>
                      <select className="textInput tallOnMobile" value={manualMovePid} onChange={(e) => setManualMovePid(e.target.value)}>
                        <option value="">Select player…</option>
                        {selectablePlayers.filter((p) => !isWithdrawnPlayer(p)).map((p) => (
                          <option key={p.pid} value={p.pid}>#{p.position} — {p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="label">Move to position</div>
                      <select className="textInput tallOnMobile" value={manualMovePosition} onChange={(e) => setManualMovePosition(e.target.value)}>
                        {Array.from({ length: Math.max(1, players.filter((p) => !isWithdrawnPlayer(p) && String(p.name || "").trim().length > 0).length) }, (_, i) => i + 1).map((pos) => {
                          const occupant = players.find((p) => !isWithdrawnPlayer(p) && p.position === pos);
                          const label = occupant?.name?.trim() ? `#${pos} (${occupant.name})` : `#${pos}`;
                          return <option key={pos} value={String(pos)}>{label}</option>;
                        })}
                      </select>
                    </div>
                    <button className="btn fullWidthOnMobile" disabled={!manualMovePid} onClick={() => openPin("manualMove")}>
                      Quietly move player
                    </button>
                  </div>
                </div>

                <div className="sep" />

                <div className="managementGrid">
                  <div className="managementBox">
                    <div className="cardTitle">Drop 3 places</div>
                    <div className="hint">Choose a period, review players with no matches in that window, then drop them in one batch.</div>
                    <select className="textInput tallOnMobile" value={dropPeriodKey} onChange={(e) => setDropPeriodKey(e.target.value)}>
                      {dropPeriods.map((period) => (
                        <option key={period.key} value={period.key}>{period.label}</option>
                      ))}
                    </select>

                    <div className="batchList">
                      {eligibleDropPlayers.length === 0 ? (
                        <div className="hint">Everyone has played in this period, or there are no eligible active players.</div>
                      ) : (
                        eligibleDropPlayers.map((p) => (
                          <label key={p.pid} className="batchCheck">
                            <input
                              type="checkbox"
                              checked={selectedDropPids.includes(p.pid)}
                              onChange={(e) => {
                                setSelectedDropPids((prev) =>
                                  e.target.checked ? [...prev, p.pid] : prev.filter((id) => id !== p.pid)
                                );
                              }}
                            />
                            <span>#{p.position} — {p.name}</span>
                          </label>
                        ))
                      )}
                    </div>

                    <div className="row" style={{ gap: 8 }}>
                      <button
                        className="btnGhost"
                        disabled={eligibleDropPlayers.length === 0}
                        onClick={() => setSelectedDropPids(eligibleDropPlayers.map((p) => p.pid))}
                      >
                        Select all
                      </button>
                      <button
                        className="btnGhost"
                        disabled={selectedDropPids.length === 0}
                        onClick={() => setSelectedDropPids([])}
                      >
                        Clear
                      </button>
                    </div>

                    <button className="btn fullWidthOnMobile" disabled={selectedDropPids.length === 0} onClick={() => openPin("drop3")}>
                      Drop {selectedDropPids.length} selected player{selectedDropPids.length === 1 ? "" : "s"} 3 places
                    </button>
                  </div>

                  <div className="managementBox">
                    <div className="cardTitle">Withdraw player</div>
                    <div className="hint">Move a player to the bottom, mark them with W, and grey out the row.</div>
                    <select className="textInput tallOnMobile" value={withdrawPid} onChange={(e) => setWithdrawPid(e.target.value)}>
                      <option value="">Select player…</option>
                      {selectablePlayers.map((p) => (
                        <option key={p.pid} value={p.pid}>
                          #{p.position} — {p.name}
                        </option>
                      ))}
                    </select>
                    <button className="btnDanger fullWidthOnMobile" disabled={!withdrawPid} onClick={() => openPin("withdraw")}>
                      Withdraw
                    </button>
                  </div>
                </div>

                <div className="sep" />
                <div className="managementBox" style={{ marginBottom: 12 }}>
                  <div className="cardTitle">Ladder Season management</div>
                  <div className="hint">Current: {seasonLabel}. You can safely edit its name and dates because its permanent ladder-season ID does not change.</div>
                  <div className="row">
                    <button className="btn" onClick={createSeason}>Create ladder season</button>
                    <button className="btnGhost" onClick={editSeason}>Edit current ladder season</button>
                    <button className="btnGhost" onClick={setPublicDefault}>Set current view as guest default</button>
                  </div>
                </div>
                <div className="cardTitle" style={{ marginBottom: 8 }}>Player count</div>
                <div className="mobileOnly collapsibleWrap">
                  <button className="collapseBtn" onClick={() => setMobileSettingsOpen((v) => !v)}>
                    {mobileSettingsOpen ? "Hide player count" : "Show player count"}
                  </button>
                </div>
                <div className={mobileSettingsOpen ? "sectionOpen" : "sectionClosedMobileOnly"}>
                  <div style={{ maxWidth: 320 }}>
                    <div className="label">How many players are in the {divisionLabel} ladder?</div>
                    <input className="textInput tallOnMobile" type="number" min={2} max={CAPACITY} value={playerCount} onChange={(e) => { const next = clamp(asNumber(e.target.value, DEFAULT_PLAYER_COUNT), 2, CAPACITY); setDirty(true); patchCurrentDivision((divisionState) => ({ ...divisionState, playerCount: next })); }} />
                    <div className="hint">Min 2, max {CAPACITY}. (Default: {DEFAULT_PLAYER_COUNT})</div>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="hint" style={{ textAlign: "center", margin: "16px 0 30px" }}>Shared cloud storage via Supabase. Everyone sees the same ladder.</div>
      </div>

      <div className="mobileBottomBar mobileOnly">
        <button className="bottomBarBtn" onClick={() => scrollToRef(addMatchRef)}>Add Match</button>
        <button className="bottomBarBtn" onClick={() => openPin("save")} disabled={locked || !dirty}>Save</button>
        <button className="bottomBarBtn" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>Top</button>
      </div>
    </div>
  );
}

const css = `
  :root {
    --bg: #0b1020;
    --card: rgba(255,255,255,0.06);
    --text: rgba(255,255,255,0.92);
    --muted: rgba(255,255,255,0.66);
    --border: rgba(255,255,255,0.10);
    --btn: rgba(255,255,255,0.12);
    --btn2: rgba(255,255,255,0.08);
    --shadow: 0 10px 30px rgba(0,0,0,0.35);
  }

  * { box-sizing: border-box; }

  .app {
    min-height: 100vh;
    color: var(--text);
    background:
      radial-gradient(1200px 700px at 20% 0%, rgba(110, 231, 183, 0.10), transparent),
      radial-gradient(900px 600px at 100% 20%, rgba(59, 130, 246, 0.10), transparent),
      var(--bg);
    padding: 18px;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  }

  .container { max-width: 1800px; margin: 0 auto; }
  .mobileOnly { display: none; }

  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .cardHeader {
    padding: 14px 14px 12px;
    display: flex;
    gap: 14px;
    align-items: flex-start;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(to bottom, rgba(255,255,255,0.04), transparent);
  }

  .cardBody { padding: 14px; }

  .title { font-size: 20px; font-weight: 800; }
  .seasonTimer { margin-top: 8px; font-size: 18px; font-weight: 900; text-align: center; letter-spacing: .03em; }
  .seasonSelect { min-width: 210px; width: auto; }
  .subtitle { margin-top: 4px; font-size: 12px; color: var(--muted); }
  .cardTitle { font-size: 14px; font-weight: 800; }

  .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; align-items: center; }

  .segControl {
    display: inline-flex;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    overflow: hidden;
    background: rgba(255,255,255,0.03);
  }

  .segBtn {
    background: transparent;
    color: rgba(255,255,255,0.75);
    border: 0;
    padding: 9px 12px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }

  .segBtn.active {
    background: rgba(255,255,255,0.12);
    color: #fff;
  }

  .btn, .btnGhost, .btnDanger {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 9px 12px;
    color: var(--text);
    cursor: pointer;
    font-weight: 700;
    font-size: 13px;
    background: var(--btn);
  }

  .btnGhost { background: var(--btn2); }
  .btnDanger { background: rgba(255,77,79,0.18); border-color: rgba(255,77,79,0.35); }
  .btn:disabled, .btnGhost:disabled, .btnDanger:disabled { opacity: 0.45; cursor: not-allowed; }

  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .error { color: rgba(255, 140, 140, 1); font-size: 13px; margin-top: 8px; }
  .errorBox {
    border: 1px solid rgba(255, 140, 140, 0.35);
    background: rgba(255, 140, 140, 0.08);
    padding: 10px 12px;
    border-radius: 12px;
    margin-bottom: 12px;
  }

  .sep { height: 1px; background: var(--border); margin: 14px 0; }

  .managementGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .managementBox {
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.035);
    border-radius: 14px;
    padding: 12px;
    display: grid;
    gap: 10px;
  }

  .batchList {
    max-height: 220px;
    overflow: auto;
    display: grid;
    gap: 6px;
    padding: 8px;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    background: rgba(0,0,0,0.12);
  }

  .batchCheck {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: var(--text);
  }

  .batchCheck input { width: 16px; height: 16px; }

  .withdrawnRow {
    opacity: 0.62;
    filter: grayscale(0.75);
  }

  .withdrawnRow td {
    background: rgba(120, 120, 120, 0.16) !important;
  }

  .withdrawnRow .nameBtn {
    color: rgba(255,255,255,0.62);
    border-color: rgba(255,255,255,0.05);
  }

  .tableWrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 14px; }
  .table { width: 100%; border-collapse: collapse; min-width: 1100px; background: rgba(0,0,0,0.12); }

  .ladderTable { min-width: 1100px; }
  .ladderTable th:nth-child(1), .ladderTable td:nth-child(1) {
    position: sticky; left: 0; z-index: 4; background: rgba(8, 12, 24, 0.98); width: 76px; min-width: 76px; max-width: 76px;
  }
  .ladderTable th:nth-child(2), .ladderTable td:nth-child(2) {
    position: sticky; left: 76px; z-index: 3; background: rgba(8, 12, 24, 0.98); box-shadow: 12px 0 20px rgba(0,0,0,0.28);
  }

  th, td { padding: 10px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: middle; }
  th { text-align: left; font-size: 13px; font-weight: 900; color: var(--muted); position: sticky; top: 0; background: rgba(12, 16, 32, 0.96); }

  .thBtn { background: transparent; border: 0; color: inherit; font-weight: 900; cursor: pointer; padding: 0; }
  .thBtn:hover { text-decoration: underline; text-underline-offset: 4px; }

  .posCell { font-weight: 900; }

  .nameBtn {
    display: inline-flex; align-items: center; justify-content: flex-start; width: 100%; padding: 6px 8px; border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.02); color: var(--text);
    font-weight: 600; font-size: 13px; letter-spacing: 0.01em; cursor: pointer; text-align: left;
  }
  .nameBtn:hover { border-color: rgba(255,255,255,0.18); }

  .textInput {
    width: 100%; padding: 9px 10px; border-radius: 12px; border: 1px solid var(--border);
    background: rgba(255,255,255,0.06); color: var(--text); outline: none;
  }
  .textInput:focus { border-color: rgba(255,255,255,0.22); }

  select.textInput { appearance: none; background: #ffffff; color: #000000; border-color: rgba(0,0,0,0.20); }
  select.textInput:disabled { opacity: 0.6; }
  select.textInput option { background: #ffffff; color: #000000; }

  .numInput {
    width: 76px; padding: 7px 8px; border-radius: 12px; border: 1px solid var(--border); background: rgba(255,255,255,0.06);
    color: var(--text); outline: none; font-variant-numeric: tabular-nums;
  }
  .numText { width: 76px; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); padding-right: 2px; }

  .diff { font-weight: 900; font-variant-numeric: tabular-nums; }
  .mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

  .matchEntryLayout {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.9fr);
    gap: 14px;
    align-items: stretch;
  }
  .matchPlayersPanel, .matchDetailsPanel {
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.025);
    border-radius: 14px;
    padding: 14px;
  }
  .matchPanelHeading {
    font-size: 12px;
    font-weight: 900;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .06em;
    margin-bottom: 10px;
  }
  .matchPlayerRow {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
  }
  .matchPlayerRow + .matchPlayerRow { margin-top: 9px; }
  .matchPlayerNumber {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.06);
    color: var(--muted);
    font-size: 12px;
    font-weight: 900;
  }
  .matchPlayerField { min-width: 0; }
  .matchPlayerField .label { margin-bottom: 4px; }
  .matchPlayerSelect { font-weight: 700; }
  .scorecardHeaderRow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 164px;
    gap: 10px;
    align-items: end;
  }
  .scorecardHeaderRow .matchPanelHeading { margin-bottom: 6px; }
  .scoreSetHeadings {
    display: grid;
    grid-template-columns: repeat(3, 48px);
    gap: 10px;
    justify-content: end;
    color: var(--muted);
    font-size: 10px;
    font-weight: 800;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: .03em;
  }
  .scorecardPlayerRow { grid-template-columns: 34px minmax(0, 1fr) 164px; }
  .scoreCellGroup {
    display: grid;
    grid-template-columns: repeat(3, 48px);
    gap: 10px;
    align-self: end;
    justify-content: end;
  }
  .scoreCell {
    width: 48px;
    height: 42px;
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px;
    background: rgba(255,255,255,0.07);
    color: var(--text);
    text-align: center;
    font-size: 16px;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
    outline: none;
  }
  .scoreCell:focus { border-color: rgba(255,255,255,0.38); }
  .scoreCell:disabled { opacity: .58; }
  .autoWinnerField {
    display: flex;
    align-items: center;
    color: var(--muted);
    cursor: default;
    user-select: none;
  }
  .autoWinnerField.resolved {
    color: var(--text);
    font-weight: 800;
  }
  .scorecardHint { margin-top: 8px; }
  .matchPositionNote {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(59,130,246,0.08);
    border: 1px solid rgba(59,130,246,0.18);
    color: var(--muted);
    font-size: 12px;
  }
  .matchPositionNote strong { color: var(--text); }
  .matchDetailsGrid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .matchScoreBlock { margin-top: 10px; }
  .matchScoreInput { font-variant-numeric: tabular-nums; }
  .matchSubmitBtn { margin-top: 10px; width: 100%; }

  .formGrid { display: grid; grid-template-columns: 1fr; gap: 10px; }
  @media (min-width: 980px) { .formGrid { grid-template-columns: repeat(5, 1fr); } }

  .label { font-size: 12px; color: var(--muted); font-weight: 800; margin-bottom: 6px; }
  .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }

  .liveHeader { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 10px; }
  .leaderRowGrid { display: grid; grid-template-columns: 1fr; gap: 10px; }
  @media (min-width: 920px) { .leaderRowGrid { grid-template-columns: repeat(3, 1fr); gap: 12px; } }

  .leaderCard { border: 1px solid var(--border); border-radius: 18px; padding: 16px; background: rgba(255,255,255,0.04); min-height: 130px; color: var(--text); text-align: left; position: relative; overflow: hidden; cursor: pointer; width: 100%; }
  .leaderCard.rank1 { transform: translateY(-10px) scale(1.025); min-height: 150px; background: linear-gradient(145deg, rgba(255,215,0,.19), rgba(255,255,255,.04)); }
  .leaderCard.rank2 { background: linear-gradient(145deg, rgba(210,220,235,.14), rgba(255,255,255,.04)); }
  .leaderCard.rank3 { background: linear-gradient(145deg, rgba(205,127,50,.16), rgba(255,255,255,.04)); }
  .leaderGlow { position:absolute; inset:-70% 20% auto; height:130px; background:rgba(255,255,255,.12); filter:blur(35px); pointer-events:none; }
  .leaderMedal { font-size: 30px !important; position: relative; }
  .formStrip { display:flex; gap:5px; margin-top:12px; }
  .formStrip span { width:24px; height:24px; border-radius:999px; display:grid; place-items:center; font-size:11px; font-weight:900; }
  .formWin { background:rgba(34,197,94,.25); } .formLoss { background:rgba(239,68,68,.23); }
  .leaderCard.empty { display: flex; align-items: center; justify-content: center; color: var(--muted); }
  .leaderMedal { font-size: 18px; }
  .leaderName { font-weight: 600; font-size: 14px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.01em; }
  .leaderSub {
    font-family: ui-rounded, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    font-weight: 800; color: rgba(255,255,255,0.78); font-size: 12.5px;
  }
  .leaderStats {
    font-family: ui-rounded, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.85); margin-top: 8px;
  }

  .playerMatchList { display: flex; flex-direction: column; gap: 10px; }
  .playerMatchRow { border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.04); border-radius: 14px; padding: 12px; }
  .playerMatchTop { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .playerMatchMid { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-top: 10px; }
  .playerMatchTitle { font-weight: 900; }
  .playerMatchScore { font-weight: 900; }
  .pillWin, .pillLoss {
    font-size: 11px; font-weight: 900; letter-spacing: 0.06em; padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12);
  }
  .pillWin { background: rgba(34, 197, 94, 0.18); color: rgba(220, 255, 230, 0.95); border-color: rgba(34, 197, 94, 0.30); }
  .pillLoss { background: rgba(239, 68, 68, 0.16); color: rgba(255, 225, 225, 0.95); border-color: rgba(239, 68, 68, 0.28); }

  .modalOverlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; padding: 18px; z-index: 50;
  }
  .modalCard {
    width: min(560px, 100%); background: rgba(18, 24, 48, 0.98); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; box-shadow: var(--shadow); overflow: hidden;
  }
  .modalHeader { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 14px 14px 12px; border-bottom: 1px solid rgba(255,255,255,0.10); }
  .modalTitle { font-weight: 900; font-size: 14px; }
  .modalBody { padding: 14px; }
  .modalFooter { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 14px 14px; border-top: 1px solid rgba(255,255,255,0.10); }
  .iconBtn { background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 14px; }
  .iconBtn:hover { color: var(--text); }

  .mobileSummary {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    margin-top: 10px;
  }
  .summaryPill {
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.04);
    border-radius: 14px;
    padding: 10px 12px;
  }
  .summaryPill.wide { grid-column: 1 / -1; }
  .summaryLabel { font-size: 11px; color: rgba(255,255,255,0.65); font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; }
  .summaryValue { font-size: 15px; font-weight: 800; margin-top: 4px; }
  .summaryValue.small { font-size: 13px; }

  .quickNav {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 2px;
    margin-bottom: 10px;
  }
  .quickNavBtn {
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.06);
    color: var(--text);
    border-radius: 999px;
    padding: 9px 12px;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
    cursor: pointer;
  }

  .swipeHint {
    font-size: 12px;
    color: rgba(255,255,255,0.75);
    margin-bottom: 8px;
    font-weight: 700;
  }

  .collapseBtn {
    width: 100%;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.05);
    color: var(--text);
    border-radius: 12px;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 700;
    text-align: left;
    cursor: pointer;
  }
  .collapsibleWrap { margin-bottom: 10px; }
  .sectionOpen { display: block; }
  .sectionClosedMobileOnly { display: block; }

  .mobileBottomBar {
    position: sticky;
    bottom: 0;
    left: 0;
    right: 0;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
    background: rgba(8, 12, 24, 0.94);
    backdrop-filter: blur(10px);
    border-top: 1px solid rgba(255,255,255,0.10);
    z-index: 40;
  }
  .bottomBarBtn {
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.07);
    color: var(--text);
    border-radius: 12px;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 800;
    cursor: pointer;
  }
  .bottomBarBtn:disabled { opacity: 0.45; cursor: not-allowed; }


  .ladderViewHeader { gap: 14px; align-items: center; }
  .ladderViewToggle { flex-shrink: 0; }
  .ladderViewToggle .segBtn { min-width: 118px; }
  .analyticsPanel { display: grid; gap: 14px; }
  .analyticsHeading { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
  .analyticsBadge { border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); border-radius: 999px; padding: 7px 11px; font-size: 12px; font-weight: 800; white-space: nowrap; }
  .analyticsKpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .analyticsKpi, .analyticsBox { border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.035); border-radius: 14px; padding: 14px; }
  .analyticsKpiLabel { font-size: 12px; color: rgba(255,255,255,0.68); font-weight: 750; }
  .analyticsKpiValue { font-size: 28px; line-height: 1.1; font-weight: 900; margin-top: 5px; }
  .analyticsKpiSub { font-size: 11px; color: rgba(255,255,255,0.62); margin-top: 4px; }
  .analyticsGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .analyticsBoxTitle { font-weight: 850; margin-bottom: 12px; }
  .barChart { display: grid; gap: 10px; }
  .barRow { display: grid; grid-template-columns: 54px minmax(80px, 1fr) 30px; gap: 9px; align-items: center; }
  .barLabel { font-size: 12px; font-weight: 750; color: rgba(255,255,255,0.75); }
  .analyticsGrid .analyticsBox:nth-child(2) .barRow { grid-template-columns: 112px minmax(80px, 1fr) 30px; }
  .barTrack { height: 10px; border-radius: 999px; background: rgba(255,255,255,0.07); overflow: hidden; }
  .barFill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, rgba(96,165,250,0.75), rgba(167,139,250,0.95)); }
  .barFill.alt { background: linear-gradient(90deg, rgba(45,212,191,0.75), rgba(96,165,250,0.95)); }
  .barValue { text-align: right; font-size: 12px; font-weight: 850; }
  .analyticsSortHint { margin-left: 8px; font-size: 11px; font-weight: 500; color: var(--muted); }
  .analyticsSortBtn { width: 100%; justify-content: flex-start; white-space: nowrap; }
  .analyticsSortBtn:hover { color: #fff; }
  .analyticsTableBox { padding: 0; overflow: hidden; }
  .analyticsTableBox > .analyticsBoxTitle { padding: 14px 14px 0; }
  .analyticsTable { min-width: 980px; }
  .h2hTable { min-width: 720px; }
  .analyticsEmpty { padding: 0 14px 14px; }
  .analyticsPosition { font-size: 11px; color: rgba(255,255,255,0.58); margin-top: 2px; }
  .analyticsForm { min-height: 22px; justify-content: flex-start; }
  .playerProfile { display: grid; gap: 14px; }
  .playerProfileModal { width: min(1080px, calc(100vw - 36px)); max-height: calc(100vh - 36px); display: flex; flex-direction: column; }
  .playerProfileModal .modalBody { overflow: auto; }
  .playerProfileToggle { width: 100%; max-width: 640px; margin: 0; }
  .playerProfileToggle .segBtn { min-width: 150px; }
  .lifetimeStats { display: grid; gap: 14px; }
  .lifetimeKpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .lifetimeStatus { padding: 24px 4px; text-align: center; }
  .careerTotals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .careerTotals > div, .lifetimeRow { border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.035); border-radius: 10px; padding: 10px 12px; }
  .lifetimeRow { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; }
  .lifetimeTable { min-width: 560px; }


  @media (max-width: 720px) {
    .mobileOnly { display: block; }
    .app { padding: 12px 12px 84px; }
    .title { font-size: 18px; }
    .cardHeader { padding: 12px; }
    .cardBody { padding: 12px; }
    .mobileStickyHeader {
      position: sticky;
      top: 0;
      z-index: 30;
      backdrop-filter: blur(10px);
      background: rgba(12, 16, 32, 0.96);
    }
    .mobileActions {
      width: 100%;
      justify-content: stretch;
      gap: 8px;
    }
    .fullOnMobile { width: 100%; }
    .segControl.fullOnMobile { width: 100%; }
    .segBtn { flex: 1; }
    th, td { padding: 9px 8px; }
    .ladderTable { min-width: 980px; }
    .mobileTableWrap { border-color: rgba(255,255,255,0.12); }
    .nameBtn {
      padding: 8px 10px;
      font-size: 13px;
      border-radius: 10px;
    }
    .textInput, .tallOnMobile {
      padding: 11px 10px;
      border-radius: 12px;
    }
    .btn, .btnGhost, .btnDanger {
      padding: 10px 12px;
      border-radius: 12px;
    }
    .fullWidthOnMobile { width: 100%; }
    .numText, .numInput { width: 56px; }
    .matchEntryLayout { grid-template-columns: 1fr; gap: 10px; }
    .matchPlayersPanel, .matchDetailsPanel { padding: 12px; }
    .matchDetailsGrid { grid-template-columns: 1fr; }
    .matchPlayerRow { grid-template-columns: 30px minmax(0, 1fr); gap: 8px; }
    .scorecardHeaderRow { grid-template-columns: minmax(0, 1fr) 128px; gap: 6px; }
    .scoreSetHeadings { grid-template-columns: repeat(3, 38px); gap: 7px; font-size: 9px; }
    .scorecardPlayerRow { grid-template-columns: 28px minmax(0, 1fr) 128px; gap: 7px; }
    .scoreCellGroup { grid-template-columns: repeat(3, 38px); gap: 7px; }
    .scoreCell { width: 38px; height: 42px; }
    .matchPlayerNumber { width: 28px; height: 28px; }
    .mobileSingle { grid-template-columns: 1fr !important; }
    .ladderViewHeader { align-items: stretch; }
    .ladderViewToggle { width: 100%; }
    .ladderViewToggle .segBtn { flex: 1; min-width: 0; }
    .analyticsKpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .lifetimeKpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .recordsGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .playerProfileToggle { max-width: none; overflow-x: auto; }
    .playerProfileToggle .segBtn { min-width: max-content; }
    .careerTotals { grid-template-columns: 1fr; }
    .analyticsGrid { grid-template-columns: 1fr; }
    .analyticsHeading { align-items: center; }
    .analyticsKpiValue { font-size: 24px; }
    .managementGrid { grid-template-columns: 1fr; }
    .mobileToolbarWrap { padding-top: 10px; }
    .stackedMobile { flex-direction: column; align-items: flex-start; }
    .roomy { padding: 14px; }
    .playerMatchList.mobileSpacious { gap: 12px; }
    .mobileFull {
      width: 100%;
      max-width: none;
      height: calc(100vh - 24px);
      display: flex;
      flex-direction: column;
    }
    .mobileFull .modalBody {
      flex: 1;
      overflow: auto;
    }
    .sectionClosedMobileOnly {
      display: none;
    }
  }

  @media (min-width: 721px) {
    .sectionClosedMobileOnly,
    .sectionOpen {
      display: block !important;
    }
  }
  .seasonHighlightsBanner {
    display:flex; align-items:center; justify-content:center; gap:16px; width:100%; margin-top:14px; padding:10px 14px;
    border:1px solid rgba(34,197,94,.35); background:rgba(34,197,94,.09); border-radius:12px; overflow-x:auto; white-space:nowrap;
  }
  .seasonHighlightItem { display:flex; align-items:baseline; justify-content:center; gap:7px; min-width:0; flex:1 0 auto; }
  .seasonHighlightLabel { color:rgba(255,255,255,.72); font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; }
  .seasonHighlightItem strong { font-size:13px; font-weight:900; color:var(--text); }
  .seasonHighlightValue { color:#86efac; font-size:12px; font-weight:800; }
  .seasonHighlightDivider { width:1px; height:20px; flex:0 0 1px; background:rgba(255,255,255,.14); }
  @media (max-width: 720px) {
    .seasonHighlightsBanner { justify-content:flex-start; gap:12px; padding:9px 11px; scrollbar-width:none; }
    .seasonHighlightsBanner::-webkit-scrollbar { display:none; }
    .seasonHighlightItem { gap:5px; }
    .seasonHighlightLabel, .seasonHighlightValue { font-size:10.5px; }
    .seasonHighlightItem strong { font-size:11.5px; }
  }
  .progressPositive { color:#4ade80; font-weight:800; }
  .progressNegative { color:#f87171; font-weight:800; }
  .progressNeutral { color:var(--muted); font-weight:700; }
  .smallKpiValue { font-size:20px !important; }
  .profileMatchup { display:flex; justify-content:space-between; gap:12px; align-items:center; }
  .recordKpi { min-height:150px; }
  .recordMeta, .recordScore { margin-top:7px; font-size:12px; color:var(--muted); line-height:1.35; }
  .recordScore { color:#dbeafe; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .recordsGrid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
  .recordItem { display:flex; flex-direction:column; gap:5px; border:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.035); border-radius:10px; padding:12px; min-width:0; }
  .recordItem span { color:var(--muted); font-size:12px; }
  .recordItem strong { overflow-wrap:anywhere; }
  .recordItem small { color:var(--muted); line-height:1.35; }

`;
