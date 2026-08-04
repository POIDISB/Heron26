import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/**
 * Heron Tennis Summer Ladder 2026 — plain React + Supabase (shared realtime).
 *
 * Multi-ladder edition:
 * - Men's + Women's ladders in one app
 * - Top toggle switches between ladders
 * - Each ladder has fully separate players, matches, and playerCount
 * - Shared cloud sync via Supabase
 * - Admin writes go through /api/admin with PIN
 * - Mobile-friendly browser layout while keeping desktop layout intact
 */

const DEFAULT_PLAYER_COUNT = 40;
const LEGACY_SEASON_ID = "may-july-2026";
const CAPACITY = 60;
const SURFACES = ["Clay", "Indoor", "Outdoor Hard Court"];
const DIVISIONS = [
  { key: "mens", label: "Men's" },
  { key: "womens", label: "Women's" },
];

const DROP_PERIODS = [
  { key: "apr26_may31", label: "April 26th – May 31st", start: "2026-04-26", end: "2026-05-31" },
  { key: "jun", label: "June 1st – June 30th", start: "2026-06-01", end: "2026-06-30" },
  { key: "jul", label: "July 1st – July 31st", start: "2026-07-01", end: "2026-07-31" },
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

function monthKeyFromDateISO(dateISO) {
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getMonth();
  if (m === 3) return "apr";
  if (m === 4) return "may";
  if (m === 5) return "jun";
  if (m === 6) return "jul";
  if (m === 7) return "aug";
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

const COLS = [
  { key: "position", label: "Pos" },
  { key: "name", label: "Name" },
  { key: "matchesPlayed", label: "Matches Played" },
  { key: "matchesWon", label: "Matches Won" },
  { key: "setsWon", label: "Sets Won" },
  { key: "setsLost", label: "Sets Lost" },
  { key: "setDiff", label: "Set Diff" },
  { key: "gamesWon", label: "Games Won" },
  { key: "gamesLost", label: "Games Lost" },
  { key: "gameDiff", label: "Game Diff" },
  { key: "apr", label: "Apr Matches" },
  { key: "may", label: "May Matches" },
  { key: "jun", label: "Jun Matches" },
  { key: "jul", label: "Jul Matches" },
];

function valueForColumn(p, colKey) {
  if (colKey === "name") return String(p.name || "").toLowerCase();
  return p[colKey];
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

function Modal({ open, title, children, actions, onClose, mobileFull = false }) {
  if (!open) return null;
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className={mobileFull ? "modalCard mobileFull" : "modalCard"}>
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
  const maxSurface = Math.max(1, ...analytics.surfaces.map((x) => x.matches));

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

        <div className="analyticsBox">
          <div className="analyticsBoxTitle">Surface split</div>
          <div className="barChart">
            {analytics.surfaces.map((item) => (
              <div className="barRow" key={item.surface}>
                <div className="barLabel surfaceLabel">{item.surface}</div>
                <div className="barTrack"><div className="barFill alt" style={{ width: `${Math.max(item.matches ? 8 : 0, (item.matches / maxSurface) * 100)}%` }} /></div>
                <div className="barValue">{item.matches}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="analyticsBox analyticsTableBox">
        <div className="analyticsBoxTitle">Player performance</div>
        {analytics.playerRows.length === 0 ? <div className="hint analyticsEmpty">Add completed matches to populate analytics.</div> : (
          <div className="tableWrap">
            <table className="table analyticsTable">
              <thead><tr><th>Player</th><th>P</th><th>W</th><th>Win %</th><th>Successful challenges</th><th>Successful defences</th><th>Set diff</th><th>Game diff</th><th>Current form</th><th>Best streak</th></tr></thead>
              <tbody>
                {analytics.playerRows.map((p) => (
                  <tr key={p.pid}>
                    <td><strong>{p.name}</strong><div className="analyticsPosition">Current #{p.position}</div></td>
                    <td>{p.played}</td><td>{p.wins}</td><td>{p.winPct}%</td><td>{p.successfulChallenges}</td><td>{p.successfulDefences}</td><td>{p.setDiff > 0 ? "+" : ""}{p.setDiff}</td><td>{p.gameDiff > 0 ? "+" : ""}{p.gameDiff}</td>
                    <td><div className="formStrip analyticsForm">{p.form.map((x, i) => <span key={i} className={x === "W" ? "formWin" : "formLoss"}>{x}</span>)}</div></td>
                    <td>{p.bestStreak}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="analyticsBox analyticsTableBox">
        <div className="analyticsBoxTitle">Head to head</div>
        {analytics.headToHead.length === 0 ? <div className="hint analyticsEmpty">Head-to-head records appear once two players have met.</div> : (
          <div className="tableWrap">
            <table className="table analyticsTable h2hTable">
              <thead><tr><th>Players</th><th>Meetings</th><th>Record</th><th>Leader</th><th>Latest result</th></tr></thead>
              <tbody>
                {analytics.headToHead.map((row) => (
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
  const surfaceMap = new Map();
  const opponentMap = new Map();
  const seasonMap = new Map();

  const normalized = careerMatches.map((m) => {
    const isChallenger = sameName(m.challenger_name);
    const didWin = (isChallenger && m.winner_id === "p1") || (!isChallenger && m.winner_id === "p2");
    const opponentName = String(isChallenger ? m.opponent_name : m.challenger_name).trim() || "Unknown";
    const parsed = parseScore(String(m.score || ""));
    let ownSets = 0, oppSets = 0, ownGames = 0, oppGames = 0;
    if (parsed.valid) {
      const computed = computeFromSets(parsed.sets);
      ownSets = isChallenger ? computed.p1Sets : computed.p2Sets;
      oppSets = isChallenger ? computed.p2Sets : computed.p1Sets;
      ownGames = isChallenger ? computed.p1Games : computed.p2Games;
      oppGames = isChallenger ? computed.p2Games : computed.p1Games;
    }
    wins += didWin ? 1 : 0;
    if (didWin) {
      currentStreak += 1;
      bestStreak = Math.max(bestStreak, currentStreak);
      if (isChallenger) successfulChallenges += 1;
      else successfulDefences += 1;
    } else currentStreak = 0;
    setsWon += ownSets; setsLost += oppSets; gamesWon += ownGames; gamesLost += oppGames;

    const surface = String(m.surface || "Other");
    const surfaceRow = surfaceMap.get(surface) || { surface, played: 0, wins: 0 };
    surfaceRow.played += 1; surfaceRow.wins += didWin ? 1 : 0; surfaceMap.set(surface, surfaceRow);

    const opponentKey = opponentName.toLowerCase();
    const oppRow = opponentMap.get(opponentKey) || { name: opponentName, played: 0, wins: 0, losses: 0 };
    oppRow.played += 1; if (didWin) oppRow.wins += 1; else oppRow.losses += 1; opponentMap.set(opponentKey, oppRow);

    const sid = String(m.season_id || "");
    const season = seasonById.get(sid);
    const seasonRow = seasonMap.get(sid) || { seasonId: sid, name: season?.name || sid || "Unknown season", startDate: season?.start_date || "", played: 0, wins: 0 };
    seasonRow.played += 1; seasonRow.wins += didWin ? 1 : 0; seasonMap.set(sid, seasonRow);

    return { id: String(m.id), seasonId: sid, seasonName: season?.name || sid, date: String(m.date || ""), opponentName, isChallenger, didWin, score: String(m.score || ""), surface };
  });

  const playerRows = (playerRes.data || []).filter((p) => sameName(p.name));
  const positions = playerRows.map((p) => Number(p.position)).filter((n) => Number.isFinite(n) && n > 0);
  const seasonsPlayed = new Set([...careerMatches.map((m) => String(m.season_id || "")), ...playerRows.map((p) => String(p.season_id || ""))].filter(Boolean));

  return {
    name: playerName,
    played: normalized.length,
    wins,
    losses: normalized.length - wins,
    winPct: normalized.length ? Math.round((wins / normalized.length) * 100) : 0,
    successfulChallenges,
    successfulDefences,
    bestStreak,
    setsWon,
    setsLost,
    gamesWon,
    gamesLost,
    highestPosition: positions.length ? Math.min(...positions) : null,
    seasonsPlayed: seasonsPlayed.size,
    surfaces: [...surfaceMap.values()].map((x) => ({ ...x, winPct: x.played ? Math.round((x.wins / x.played) * 100) : 0 })).sort((a, b) => b.played - a.played),
    headToHead: [...opponentMap.values()].sort((a, b) => b.played - a.played || b.wins - a.wins || a.name.localeCompare(b.name)),
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
  const [winner, setWinner] = useState("p2");
  const [surface, setSurface] = useState("Outdoor Hard Court");
  const [score, setScore] = useState("");
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
  const [editSurface, setEditSurface] = useState("Outdoor Hard Court");
  const [editWinner, setEditWinner] = useState("p2");
  const [editScore, setEditScore] = useState("");
  const [editError, setEditError] = useState("");

  const [pinOpen, setPinOpen] = useState(false);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinPurpose, setPinPurpose] = useState("unlock");
  const [pinPayload, setPinPayload] = useState(null);
  const pinRef = useRef(null);

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
    setWinner("p2");
    setMatchPos("1");
    setChallengerPid("");
    setScore("");
    setError("");
    setMatchDate(formatDateISO(new Date()));
    setManualMovePid("");
    setManualMovePosition("1");
  }, [activeDivision]);

  useEffect(() => {
    const mp = clamp(asNumber(matchPos, 1), 1, playerCount);
    if (String(mp) !== matchPos) setMatchPos(String(mp));
  }, [playerCount, matchPos]);

  useEffect(() => {
    const refreshDateIfBlank = () => {
      if (!matchDate) setMatchDate(formatDateISO(new Date()));
    };
    window.addEventListener("focus", refreshDateIfBlank);
    return () => window.removeEventListener("focus", refreshDateIfBlank);
  }, [matchDate]);

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

  const calculatedPlayers = useMemo(
    () =>
      visiblePlayers.map((p) => ({
        ...p,
        setDiff: (p.setsWon || 0) - (p.setsLost || 0),
        gameDiff: (p.gamesWon || 0) - (p.gamesLost || 0),
      })),
    [visiblePlayers]
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

  const selectablePlayers = useMemo(
    () =>
      players
        .filter((p) => p.position >= 1 && p.position <= playerCount)
        .filter((p) => !isWithdrawnPlayer(p))
        .filter((p) => String(p.name || "").trim().length > 0)
        .sort((a, b) => a.position - b.position),
    [players, playerCount]
  );

  const selectedDropPeriod = useMemo(
    () => DROP_PERIODS.find((p) => p.key === dropPeriodKey) || DROP_PERIODS[0],
    [dropPeriodKey]
  );

  const eligibleDropPlayers = useMemo(() => {
    const period = DROP_PERIODS.find((p) => p.key === dropPeriodKey) || DROP_PERIODS[0];

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
  }, [players, matches, playerCount, dropPeriodKey]);

  useEffect(() => {
    setSelectedDropPids(eligibleDropPlayers.map((p) => p.pid));
  }, [dropPeriodKey, activeDivision, eligibleDropPlayers.length]);

  const leaderboardTop3 = useMemo(() => {
    const named = calculatedPlayers.filter((p) => !isWithdrawnPlayer(p) && String(p.name || "").trim().length > 0);
    return [...named].sort((a, b) => a.position - b.position).slice(0, 3);
  }, [calculatedPlayers]);

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

  const activeSeason = seasons.find((x) => String(x.id) === String(activeSeasonId)) || null;
  const seasonLabel = activeSeason?.name || "Season";

  const analytics = useMemo(() => {
    const realMatches = matchesView.filter((m) => !String(m.score || "").startsWith("ADMIN:"));
    const namedActive = calculatedPlayers.filter((p) => !isWithdrawnPlayer(p) && String(p.name || "").trim());
    const monthLabels = [
      ["apr", "Apr"], ["may", "May"], ["jun", "Jun"], ["jul", "Jul"], ["aug", "Aug"],
      ["sep", "Sep"], ["oct", "Oct"], ["nov", "Nov"], ["dec", "Dec"], ["jan", "Jan"], ["feb", "Feb"], ["mar", "Mar"],
    ];
    const monthlyCounts = new Map();
    const surfaceCounts = new Map(SURFACES.map((x) => [x, 0]));
    let deciders = 0;
    let challengerWins = 0;

    for (const m of realMatches) {
      const d = new Date(`${m.date}T12:00:00`);
      if (!Number.isNaN(d.getTime())) {
        const key = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"][d.getMonth()];
        monthlyCounts.set(key, (monthlyCounts.get(key) || 0) + 1);
      }
      const surf = String(m.surface || "Other");
      surfaceCounts.set(surf, (surfaceCounts.get(surf) || 0) + 1);
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
      surfaces: [...surfaceCounts.entries()].map(([surface, count]) => ({ surface, matches: count })).filter((x) => x.matches > 0 || SURFACES.includes(x.surface)),
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
    const monthKey = monthKeyFromDateISO(matchDate);
    const challengerStartPos = p1.position;
    const opponentStartPos = p2.position;

    const shouldMove = winner === "p1" && challengerStartPos > opponentStartPos;
    const moved = shouldMove ? applyLadderMove(players, p1.pid, opponentStartPos) : { players, applied: false };

    const matchRecord = {
      id: uid(),
      division: activeDivision,
      date: matchDate,
      positionPlayedFor: opponentStartPos,
      challengerPid: p1.pid,
      opponentPid: p2.pid,
      winnerId: winner,
      challengerName: p1.name || "",
      opponentName: p2.name || "",
      winnerNameSnapshot: winner === "p1" ? (p1.name || "") : (p2.name || ""),
      score: String(score || "").trim(),
      surface,
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
            const didWin = (winner === "p1" && isP1) || (winner === "p2" && !isP1);
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
    setEditSurface(match.surface || "Outdoor Hard Court");
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
      surface: editSurface,
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

    const period = DROP_PERIODS.find((p) => p.key === dropPeriodKey) || DROP_PERIODS[0];
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
      ? "Unlock editing for this session (viewers remain read-only)."
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
      const historyRows = matchesView.map((m) => ({ Date: m.date, Challenger: m.p1Name, Opponent: m.p2Name, Winner: m.winnerName, Score: formatScore(m.score), Surface: m.surface, "Position Played For": m.positionPlayedFor }));
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
    const name = window.prompt("New season name", "August–October 2026"); if (!name) return;
    const startDate = window.prompt("Start date (YYYY-MM-DD)", "2026-08-01"); if (!startDate) return;
    const endDate = window.prompt("End date (YYYY-MM-DD)", "2026-10-31"); if (!endDate) return;
    const pin = window.prompt("Admin PIN"); if (!pin) return;
    try { const result = await adminAction(pin, "createSeason", { name, startDate, endDate }); const meta = await fetchSeasonMeta(); setSeasons(meta.seasons); setActiveSeasonId(result.season.id); }
    catch (e) { setError(String(e?.message || e)); }
  }

  async function renameSeason() {
    if (!activeSeason) return; const name = window.prompt("Season name", activeSeason.name); if (!name || name === activeSeason.name) return; const pin = window.prompt("Admin PIN"); if (!pin) return;
    try { await adminAction(pin, "renameSeason", { seasonId: activeSeasonId, name }); const meta = await fetchSeasonMeta(); setSeasons(meta.seasons); }
    catch (e) { setError(String(e?.message || e)); }
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

          return (
            <div className="playerProfile">
              <div className="segControl playerProfileToggle" role="tablist" aria-label="Player profile view">
                <button className={playerModalView === "recent" ? "segBtn active" : "segBtn"} onClick={() => setPlayerModalView("recent")}>Recent Matches</button>
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
                            <div><div className="playerMatchTitle">{pname} vs {opponentName}</div><div className="hint">{isChallenger ? `Challenging for Position #${m.positionPlayedFor}` : `Defending Position #${m.positionPlayedFor}`} • {m.surface || "—"}{m.ladderMoveApplied ? " • Ladder moved" : ""}</div></div>
                            <div className="mono playerMatchScore">{formatScoreForPlayer(m.score, isChallenger)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
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
                    </div>

                    <div className="analyticsGrid">
                      <div className="analyticsBox"><div className="analyticsBoxTitle">Career totals</div><div className="careerTotals"><div>Sets <strong>{lifetimeStats.setsWon}–{lifetimeStats.setsLost}</strong></div><div>Games <strong>{lifetimeStats.gamesWon}–{lifetimeStats.gamesLost}</strong></div><div>Set diff <strong>{lifetimeStats.setsWon - lifetimeStats.setsLost >= 0 ? "+" : ""}{lifetimeStats.setsWon - lifetimeStats.setsLost}</strong></div><div>Game diff <strong>{lifetimeStats.gamesWon - lifetimeStats.gamesLost >= 0 ? "+" : ""}{lifetimeStats.gamesWon - lifetimeStats.gamesLost}</strong></div></div></div>
                      <div className="analyticsBox"><div className="analyticsBoxTitle">Surface record</div>{lifetimeStats.surfaces.length ? lifetimeStats.surfaces.map((x) => <div className="lifetimeRow" key={x.surface}><span>{x.surface}</span><strong>{x.wins}–{x.played - x.wins} ({x.winPct}%)</strong></div>) : <div className="hint">No surface data.</div>}</div>
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
            <div className="label">Surface</div>
            <select className="textInput" value={editSurface} onChange={(e) => setEditSurface(e.target.value)}>
              {SURFACES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
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
                        {COLS.map((c) => <th key={c.key}><button className="thBtn" onClick={() => toggleSort(c.key)}>{c.label}{sortIndicator(c.key)}</button></th>)}
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
                          <td><StatCell locked={locked} value={p.matchesPlayed} onChange={(v) => updatePlayer(p.pid, "matchesPlayed", v)} /></td>
                          <td><StatCell locked={locked} value={p.matchesWon} onChange={(v) => updatePlayer(p.pid, "matchesWon", v)} /></td>
                          <td><StatCell locked={locked} value={p.setsWon} onChange={(v) => updatePlayer(p.pid, "setsWon", v)} /></td>
                          <td><StatCell locked={locked} value={p.setsLost} onChange={(v) => updatePlayer(p.pid, "setsLost", v)} /></td>
                          <td className="diff">{p.setDiff}</td>
                          <td><StatCell locked={locked} value={p.gamesWon} onChange={(v) => updatePlayer(p.pid, "gamesWon", v)} /></td>
                          <td><StatCell locked={locked} value={p.gamesLost} onChange={(v) => updatePlayer(p.pid, "gamesLost", v)} /></td>
                          <td className="diff">{p.gameDiff}</td>
                          <td><StatCell locked={locked} value={p.apr} onChange={(v) => updatePlayer(p.pid, "apr", v)} /></td>
                          <td><StatCell locked={locked} value={p.may} onChange={(v) => updatePlayer(p.pid, "may", v)} /></td>
                          <td><StatCell locked={locked} value={p.jun} onChange={(v) => updatePlayer(p.pid, "jun", v)} /></td>
                          <td><StatCell locked={locked} value={p.jul} onChange={(v) => updatePlayer(p.pid, "jul", v)} /></td>
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
            <div className="formGrid mobileStackFriendly">
              <div>
                <div className="label">Date</div>
                <input className="textInput tallOnMobile" type="date" value={matchDate} onChange={(e) => setMatchDate(e.target.value)} disabled={locked} />
              </div>
              <div>
                <div className="label">Position being played for</div>
                <select className="textInput tallOnMobile" value={matchPos} onChange={(e) => setMatchPos(e.target.value)} disabled={locked}>
                  {Array.from({ length: playerCount }, (_, i) => {
                    const pos = i + 1;
                    const p = players.find((x) => x.position === pos);
                    const nm = p?.name?.trim();
                    return <option key={pos} value={String(pos)}>#{pos}{nm ? ` (${nm})` : ""}</option>;
                  })}
                </select>
                <div className="hint">Selected: {opponentLabel}</div>
              </div>
              <div>
                <div className="label">Challenger</div>
                <select className="textInput tallOnMobile" value={challengerPid} onChange={(e) => setChallengerPid(e.target.value)} disabled={locked}>
                  <option value="">Select…</option>
                  {selectablePlayers.map((p) => <option key={p.pid} value={p.pid}>#{p.position} — {p.name}</option>)}
                </select>
                <div className="hint">Tip: add names first, then they appear here.</div>
              </div>
              <div>
                <div className="label">Surface</div>
                <select className="textInput tallOnMobile" value={surface} onChange={(e) => setSurface(e.target.value)} disabled={locked}>
                  {SURFACES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Winner</div>
                <select className="textInput tallOnMobile" value={winner} onChange={(e) => setWinner(e.target.value)} disabled={locked}>
                  <option value="p1">{challenger?.name?.trim() ? challenger.name : "Challenger"}</option>
                  <option value="p2">{opponent?.name?.trim() ? opponent.name : "Opponent"}</option>
                </select>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="label">Score (From {challenger?.name?.trim() ? `${challenger.name}'s` : "Challenger's"} perspective)</div>
              <input className="textInput tallOnMobile" value={score} onChange={(e) => setScore(e.target.value)} placeholder="e.g. 6-4 3-6 10-8" disabled={locked} />
              <div className="hint">Valid: 6-x, 7-5, 7-6, or match tie-break 10+ (win by 2).</div>
              <button className="btn fullWidthOnMobile" style={{ marginTop: 10 }} onClick={requestAddMatch} disabled={locked}>Add match</button>
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
                        <th>Date</th><th>Played for</th><th>Challenger</th><th>Opponent</th><th>Surface</th><th>Winner</th><th>Score</th>{!locked ? <th style={{ textAlign: "right" }}>Actions</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {matchesView.map((m) => (
                        <tr key={m.id}>
                          <td className="mono">{m.date}</td>
                          <td>#{m.positionPlayedFor}</td>
                          <td>{String(m.score || "").startsWith("ADMIN:") ? m.p1Name : m.p1Name}</td>
                          <td>{String(m.score || "").startsWith("ADMIN:") ? "—" : m.p2Name}</td>
                          <td>{m.surface || "—"}</td>
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
                      {DROP_PERIODS.map((period) => (
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
                  <div className="cardTitle">Season management</div>
                  <div className="hint">Current: {seasonLabel}. Renaming is safe because data uses the permanent season ID.</div>
                  <div className="row">
                    <button className="btn" onClick={createSeason}>Create season</button>
                    <button className="btnGhost" onClick={renameSeason}>Rename current</button>
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
  .surfaceLabel { width: 105px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .analyticsGrid .analyticsBox:nth-child(2) .barRow { grid-template-columns: 112px minmax(80px, 1fr) 30px; }
  .barTrack { height: 10px; border-radius: 999px; background: rgba(255,255,255,0.07); overflow: hidden; }
  .barFill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, rgba(96,165,250,0.75), rgba(167,139,250,0.95)); }
  .barFill.alt { background: linear-gradient(90deg, rgba(45,212,191,0.75), rgba(96,165,250,0.95)); }
  .barValue { text-align: right; font-size: 12px; font-weight: 850; }
  .analyticsTableBox { padding: 0; overflow: hidden; }
  .analyticsTableBox > .analyticsBoxTitle { padding: 14px 14px 0; }
  .analyticsTable { min-width: 980px; }
  .h2hTable { min-width: 720px; }
  .analyticsEmpty { padding: 0 14px 14px; }
  .analyticsPosition { font-size: 11px; color: rgba(255,255,255,0.58); margin-top: 2px; }
  .analyticsForm { min-height: 22px; justify-content: flex-start; }
  .playerProfile { display: grid; gap: 14px; }
  .playerProfileToggle { width: min(100%, 520px); margin: 0 auto; }
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
    .mobileSingle { grid-template-columns: 1fr !important; }
    .ladderViewHeader { align-items: stretch; }
    .ladderViewToggle { width: 100%; }
    .ladderViewToggle .segBtn { flex: 1; min-width: 0; }
    .analyticsKpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .lifetimeKpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
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
`;
