import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/**
 * Heron Tennis Summer Ladder 2026 — plain React + Supabase (shared realtime).
 *
 * What changed vs localStorage version:
 * - Reads players/matches/playerCount from Supabase on startup
 * - Subscribes to realtime changes (players/matches/settings) and refetches
 * - Writes are done through /api/admin (server checks ADMIN_PIN)
 * - Frontend never uses Supabase service role key
 */

const DEFAULT_PLAYER_COUNT = 40;
const CAPACITY = 60; // hard cap
const SURFACES = ["Clay", "Indoor", "Outdoor Hard Court"]; // display + storage

// Supabase public client (read-only; write is blocked by RLS)
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

function createEmptyPlayer(position) {
  return {
    pid: `p${position}`,
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
  };
}

function defaultState() {
  return {
    playerCount: DEFAULT_PLAYER_COUNT,
    players: Array.from({ length: CAPACITY }, (_, i) => createEmptyPlayer(i + 1)),
    matches: [],
  };
}

// ---- Score parsing (no regex literals) ----
// Accepted per-set: 6-0..6-4, 7-5, 7-6, match tie-break 10+ (win by 2)

function parseScore(scoreStr) {
  const raw = String(scoreStr || "").trim();
  if (!raw) return { valid: false, sets: [], message: "Please enter a score (e.g. 6-4 6-3)." };

  // Normalize whitespace WITHOUT regex (avoid escape sequences getting mangled in deployments)
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  let cleaned = raw.split(NL).join(" ").split(TAB).join(" ");
  while (cleaned.includes("  ")) cleaned = cleaned.split("  ").join(" ");

  const parts = cleaned.split(" ").filter(Boolean);
  const sets = [];

  for (const part of parts) {
    let a = "";
    let b = "";

    if (part.includes("-")) {
      const bits = part.split("-");
      if (bits.length !== 2) return { valid: false, sets: [], message: `Couldn't read set: "${part}"` };
      a = bits[0];
      b = bits[1];
    } else if (part.includes(":")) {
      const bits = part.split(":");
      if (bits.length !== 2) return { valid: false, sets: [], message: `Couldn't read set: "${part}"` };
      a = bits[0];
      b = bits[1];
    } else {
      return { valid: false, sets: [], message: `Couldn't read set: "${part}"` };
    }

    const p1 = asNumber(a, NaN);
    const p2 = asNumber(b, NaN);
    if (!Number.isFinite(p1) || !Number.isFinite(p2)) {
      return { valid: false, sets: [], message: `Couldn't read set: "${part}"` };
    }

    sets.push({ p1, p2 });
  }

  return { valid: true, sets };
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
      // match tie-break style
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
    p1Games += s.p1;
    p2Games += s.p2;
    if (s.p1 > s.p2) p1Sets += 1;
    else if (s.p2 > s.p1) p2Sets += 1;
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
  { key: "aug", label: "Aug Matches" },
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

function compareLeaderboard(a, b) {
  if ((b.matchesWon ?? 0) !== (a.matchesWon ?? 0)) return (b.matchesWon ?? 0) - (a.matchesWon ?? 0);
  if ((b.setDiff ?? 0) !== (a.setDiff ?? 0)) return (b.setDiff ?? 0) - (a.setDiff ?? 0);
  if ((b.gameDiff ?? 0) !== (a.gameDiff ?? 0)) return (b.gameDiff ?? 0) - (a.gameDiff ?? 0);
  if ((a.matchesPlayed ?? 0) !== (b.matchesPlayed ?? 0)) return (a.matchesPlayed ?? 0) - (b.matchesPlayed ?? 0);
  return String(a.name || "").localeCompare(String(b.name || ""));
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

function Modal({ open, title, children, actions, onClose }) {
  if (!open) return null;
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modalCard">
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
  return (
    <input className="numInput" type="number" min={0} value={value} onChange={(e) => onChange(asNumber(e.target.value, 0))} />
  );
}

function LeaderCard({ medal, p }) {
  if (!p) return <div className="leaderCard empty">—</div>;
  return (
    <div className="leaderCard">
      <div className="leaderMedal">{medal}</div>
      <div className="leaderName" title={p.name}>
        {p.name}
      </div>
      <div className="leaderSub" style={{ marginTop: 4 }}>
        Pos #{p.position}
      </div>
      <div className="leaderStats mono">
        <div>W: {p.matchesWon}</div>
        <div>
          SD: {p.setDiff} • GD: {p.gameDiff}
        </div>
      </div>
    </div>
  );
}

function SelfTests() {
  // Opt-in: set window.__RUN_LADDER_TESTS__ = true in dev tools.
  const [ran, setRan] = useState(false);

  useEffect(() => {
    const w = window;
    if (!w || !w.__RUN_LADDER_TESTS__) return;
    if (ran) return;

    const assert = (cond, msg) => {
      if (!cond) throw new Error(`Test failed: ${msg}`);
    };

    assert(validateSets([{ p1: 6, p2: 4 }, { p1: 6, p2: 3 }]).ok, "6-4 6-3 valid");
    assert(!validateSets([{ p1: 6, p2: 5 }, { p1: 6, p2: 4 }]).ok, "6-5 invalid");
    assert(validateSets([{ p1: 7, p2: 6 }, { p1: 6, p2: 7 }, { p1: 10, p2: 8 }]).ok, "7-6 6-7 10-8 valid");
    assert(!validateSets([{ p1: 6, p2: 4 }, { p1: 4, p2: 6 }]).ok, "1-1 sets tie invalid");
    assert(!validateSets([{ p1: 10, p2: 9 }, { p1: 6, p2: 4 }]).ok, "TB 10-9 invalid (not win by 2)");

    const NL = String.fromCharCode(10);
    const TAB = String.fromCharCode(9);

    const ps1 = parseScore("6-4" + NL + "6-3");
    assert(ps1.valid && ps1.sets.length === 2, "parseScore accepts newlines");

    const ps2 = parseScore("6-4" + TAB + "6-3");
    assert(ps2.valid && ps2.sets.length === 2, "parseScore accepts tabs");

    const psBad = parseScore("hello world");
    assert(!psBad.valid, "parseScore rejects invalid input");

    const base = Array.from({ length: 5 }, (_, i) => ({ ...createEmptyPlayer(i + 1), name: `P${i + 1}` }));
    const moved = applyLadderMove(base, "p5", 2);
    assert(moved.applied, "move applied");
    assert(moved.players.find((p) => p.pid === "p5")?.position === 2, "challenger moved to 2");

    const reversed = reverseLadderMove(moved.players, "p5", 5, 2);
    assert(reversed.find((p) => p.pid === "p5")?.position === 5, "challenger back to 5");

    const mk = monthKeyFromDateISO("2026-04-01");
    assert(mk === "apr", "monthKeyFromDateISO maps April");

    // eslint-disable-next-line no-console
    console.log("✅ Ladder self-tests passed");
    setRan(true);
  }, [ran]);

  return null;
}

async function fetchCloudState() {
  if (!supabase) throw new Error("Supabase client not configured. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");

  const [pRes, mRes, sRes] = await Promise.all([
    supabase.from("players").select("*").order("position", { ascending: true }),
    supabase.from("matches").select("*").order("created_at", { ascending: false }),
    supabase.from("settings").select("*").eq("key", "playerCount").maybeSingle(),
  ]);

  if (pRes.error) throw new Error(pRes.error.message);
  if (mRes.error) throw new Error(mRes.error.message);
  if (sRes.error) throw new Error(sRes.error.message);

  const base = defaultState();

  const byPos = new Map();
  for (const row of pRes.data || []) {
    byPos.set(Number(row.position), row);
  }

  const players = [];
  for (let pos = 1; pos <= CAPACITY; pos++) {
    const row = byPos.get(pos);
    if (!row) {
      players.push(createEmptyPlayer(pos));
      continue;
    }
    players.push({
      ...createEmptyPlayer(pos),
      pid: String(row.pid ?? `p${pos}`),
      position: pos,
      name: String(row.name || ""),
      matchesPlayed: asNumber(row.matches_played, 0),
      matchesWon: asNumber(row.matches_won, 0),
      setsWon: asNumber(row.sets_won, 0),
      setsLost: asNumber(row.sets_lost, 0),
      gamesWon: asNumber(row.games_won, 0),
      gamesLost: asNumber(row.games_lost, 0),
      apr: asNumber(row.apr, 0),
      may: asNumber(row.may, 0),
      jun: asNumber(row.jun, 0),
      jul: asNumber(row.jul, 0),
      aug: asNumber(row.aug, 0),
    });
  }

  const matches = (mRes.data || []).map((row) => ({
    id: String(row.id),
    date: String(row.date || ""),
    positionPlayedFor: asNumber(row.position_played_for, 1),
    challengerPid: String(row.challenger_pid || ""),
    opponentPid: String(row.opponent_pid || ""),
    winnerId: row.winner_id === "p1" || row.winner_id === "p2" ? row.winner_id : "p2",
    score: String(row.score || ""),
    surface: String(row.surface || ""),
    challengerStartPos: asNumber(row.challenger_start_pos, 0),
    opponentStartPos: asNumber(row.opponent_start_pos, 0),
    ladderMoveApplied: Boolean(row.ladder_move_applied),
  }));

  const playerCount = clamp(asNumber(sRes.data?.value ?? base.playerCount, base.playerCount), 2, CAPACITY);

  return { playerCount, players, matches };
}

async function saveCloudState(pin, state) {
  const res = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pin,
      action: "saveState",
      payload: {
        playerCount: state.playerCount,
        players: state.players,
        matches: state.matches,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Failed to save.");
  return data;
}

export default function App() {
  const [state, setState] = useState(() => defaultState());
  const { players, matches, playerCount } = state;

  // Cloud status
  const [cloudError, setCloudError] = useState("");
  const [cloudLoading, setCloudLoading] = useState(true);
  const [dirty, setDirty] = useState(false); // local edits not yet pushed to cloud

  // Locking
  const [locked, setLocked] = useState(true);

  // Sorting
  const [sortKey, setSortKey] = useState("position");
  const [sortDir, setSortDir] = useState("asc");

  // Live top 3 (ladder order by default)
  const [leaderboardMode, setLeaderboardMode] = useState("ladder"); // kept for compatibility but no toggle shown

  // Match form
  const [matchDate, setMatchDate] = useState(formatDateISO(new Date()));
  const [matchPos, setMatchPos] = useState("1");
  const [challengerPid, setChallengerPid] = useState("");
  const [winner, setWinner] = useState("p2"); // default challenged
  const [surface, setSurface] = useState("Outdoor Hard Court");
  const [score, setScore] = useState("");
  const [error, setError] = useState("");

  // Modals
  const [matchAddedOpen, setMatchAddedOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState(null);

  // Player results modal
  const [playerModalOpen, setPlayerModalOpen] = useState(false);
  const [playerModalPid, setPlayerModalPid] = useState(null);

  // Edit match modal
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editDate, setEditDate] = useState("");
  const [editSurface, setEditSurface] = useState("Outdoor Hard Court");
  const [editWinner, setEditWinner] = useState("p2");
  const [editScore, setEditScore] = useState("");
  const [editError, setEditError] = useState("");

  // PIN modal
  const [pinOpen, setPinOpen] = useState(false);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinPurpose, setPinPurpose] = useState("unlock"); // unlock | add | delete | edit | save
  const [pinPayload, setPinPayload] = useState(null);
  const pinRef = useRef(null);

  // Load from cloud on startup + subscribe to realtime
  useEffect(() => {
    let alive = true;

    async function load() {
      setCloudError("");
      setCloudLoading(true);
      try {
        const cloudState = await fetchCloudState();
        if (!alive) return;
        setState(cloudState);
        setDirty(false);
      } catch (e) {
        if (!alive) return;
        setCloudError(String(e?.message || e || "Failed to load from cloud."));
      } finally {
        if (!alive) return;
        setCloudLoading(false);
      }
    }

    load();

    if (!supabase) return () => {
      alive = false;
    };

    // Realtime: refetch on any change (simplest + reliable)
    const channel = supabase
      .channel("heron-ladder")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players" },
        () => load()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "matches" },
        () => load()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "settings" },
        () => load()
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    // Default winner to the person being challenged
    setWinner("p2");
  }, [matchPos]);

  useEffect(() => {
    // Keep match position within range when playerCount changes
    const mp = clamp(asNumber(matchPos, 1), 1, playerCount);
    if (String(mp) !== matchPos) setMatchPos(String(mp));
  }, [playerCount, matchPos]);

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
        // unlock is client-only; write actions require pin again
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
        // we still need the pin when confirming, store it:
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
    } catch (e) {
      setPinError(String(e?.message || e || "PIN action failed"));
    }
  }

  function updatePlayer(pid, field, value) {
    if (locked) return;
    setDirty(true);
    setState((prev) => ({
      ...prev,
      players: prev.players.map((p) => {
        if (p.pid !== pid) return p;
        if (field === "name") return { ...p, name: String(value) };
        return { ...p, [field]: asNumber(value, 0) };
      }),
    }));
  }

  const visiblePlayers = useMemo(() => {
    return players.filter((p) => p.position >= 1 && p.position <= playerCount);
  }, [players, playerCount]);

  const calculatedPlayers = useMemo(() => {
    return visiblePlayers.map((p) => ({
      ...p,
      setDiff: (p.setsWon || 0) - (p.setsLost || 0),
      gameDiff: (p.gamesWon || 0) - (p.gamesLost || 0),
    }));
  }, [visiblePlayers]);

  const displayedPlayers = useMemo(() => {
    const arr = [...calculatedPlayers];
    arr.sort((a, b) => compareByColumn(a, b, sortKey, sortDir));
    return arr;
  }, [calculatedPlayers, sortKey, sortDir]);

  const opponent = useMemo(() => {
    const pos = Number(matchPos) || 1;
    return players.find((p) => p.position === pos) || null;
  }, [matchPos, players]);

  const challenger = useMemo(() => {
    return players.find((p) => p.pid === challengerPid) || null;
  }, [challengerPid, players]);

  const selectablePlayers = useMemo(() => {
    return players
      .filter((p) => p.position >= 1 && p.position <= playerCount)
      .filter((p) => String(p.name || "").trim().length > 0)
      .sort((a, b) => a.position - b.position);
  }, [players, playerCount]);

  const leaderboardTop3 = useMemo(() => {
    const named = calculatedPlayers.filter((p) => String(p.name || "").trim().length > 0);
    if (leaderboardMode === "stats") return [...named].sort(compareLeaderboard).slice(0, 3);
    return [...named].sort((a, b) => a.position - b.position).slice(0, 3);
  }, [calculatedPlayers, leaderboardMode]);

  const matchesView = useMemo(() => {
    const byPid = new Map(players.map((p) => [p.pid, p]));
    const isActive = (pid) => {
      const p = byPid.get(pid);
      return p ? p.position >= 1 && p.position <= playerCount : false;
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

        const p1Base = p1?.name || "(Unknown)";
        const p2Base = p2?.name || "(Unknown)";
        const p1Name = isActive(m.challengerPid) ? p1Base : `${p1Base} (Inactive)`;
        const p2Name = isActive(m.opponentPid) ? p2Base : `${p2Base} (Inactive)`;

        const winnerName = m.winnerId === "p1" ? p1Name : p2Name;

        return { ...m, p1Name, p2Name, winnerName: winnerName || "(Unknown)" };
      });
  }, [matches, players, playerCount]);

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
    if (locked) {
      setError("Locked: Admin unlock required.");
      return;
    }

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
      date: matchDate,
      positionPlayedFor: opponentStartPos,
      challengerPid: p1.pid,
      opponentPid: p2.pid,
      winnerId: winner,
      score: String(score || "").trim(),
      surface,
      challengerStartPos,
      opponentStartPos,
      ladderMoveApplied: moved.applied,
    };

    const nextState = (() => {
      const updatedPlayers = state.players
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
        });

      return {
        ...state,
        matches: [matchRecord, ...state.matches],
        players: updatedPlayers,
      };
    })();

    // Optimistic UI
    setState(nextState);

    try {
      await saveCloudState(pin, nextState);
      setMatchAddedOpen(true);
      setScore("");
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

    const parsed = parseScore(match.score);

    const nextState = (() => {
      let nextPlayers = state.players;

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

      return {
        ...state,
        matches: state.matches.filter((m) => m.id !== id),
        players: nextPlayers,
      };
    })();

    setState(nextState);

    try {
      await saveCloudState(pin, nextState);
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
    setEditError("");
    openPin("edit");
  }

  async function actuallySaveEdit(pin) {
    setEditError("");
    const id = editId;
    if (!id) {
      setEditError("No match selected.");
      return;
    }

    const original = state.matches.find((m) => m.id === id);
    if (!original) {
      setEditError("Match not found.");
      return;
    }

    // Validate new score
    const parsedNew = parseScore(editScore);
    if (!parsedNew.valid) {
      setEditError(parsedNew.message || "Score not recognised.");
      return;
    }
    const vNew = validateSets(parsedNew.sets);
    if (!vNew.ok) {
      setEditError(vNew.message);
      return;
    }

    // Build nextState by: delete original effects, then apply new effects.
    const nextState = (() => {
      // 1) start from current state
      let s = { ...state, players: state.players.map((p) => ({ ...p })), matches: [...state.matches] };

      // helper to apply a match delta (+1 for add, -1 for remove)
      const applyMatchDelta = (matchObj, dir) => {
        const parsed = parseScore(matchObj.score);
        if (!parsed.valid) throw new Error("Stored score invalid; can't edit safely.");
        const valid = validateSets(parsed.sets);
        if (!valid.ok) throw new Error("Stored score invalid; can't edit safely.");

        const { p1Sets, p2Sets, p1Games, p2Games } = computeFromSets(parsed.sets);
        const monthKey = monthKeyFromDateISO(matchObj.date);

        s.players = s.players.map((p) => {
          if (p.pid !== matchObj.challengerPid && p.pid !== matchObj.opponentPid) return p;

          const isP1 = p.pid === matchObj.challengerPid;
          const setsWon = isP1 ? p1Sets : p2Sets;
          const setsLost = isP1 ? p2Sets : p1Sets;
          const gamesWon = isP1 ? p1Games : p2Games;
          const gamesLost = isP1 ? p2Games : p1Games;
          const didWin = (matchObj.winnerId === "p1" && isP1) || (matchObj.winnerId === "p2" && !isP1);

          const out = {
            ...p,
            matchesPlayed: clampMin0((p.matchesPlayed || 0) + 1 * dir),
            matchesWon: clampMin0((p.matchesWon || 0) + (didWin ? 1 : 0) * dir),
            setsWon: clampMin0((p.setsWon || 0) + setsWon * dir),
            setsLost: clampMin0((p.setsLost || 0) + setsLost * dir),
            gamesWon: clampMin0((p.gamesWon || 0) + gamesWon * dir),
            gamesLost: clampMin0((p.gamesLost || 0) + gamesLost * dir),
          };
          if (monthKey) out[monthKey] = clampMin0((p[monthKey] || 0) + 1 * dir);
          return out;
        });
      };

      // 2) reverse ladder move if applied (for original)
      if (original.ladderMoveApplied) {
        s.players = reverseLadderMove(s.players, original.challengerPid, original.challengerStartPos, original.opponentStartPos);
      }

      // 3) subtract original stats
      applyMatchDelta(original, -1);

      // 4) create edited match object (preserve start positions, but playedFor uses opponentStartPos)
      const edited = {
        ...original,
        date: editDate,
        surface: editSurface,
        winnerId: editWinner,
        score: String(editScore || "").trim(),
      };

      // 5) Determine if ladder move should apply now
      const p1 = s.players.find((p) => p.pid === edited.challengerPid);
      const p2 = s.players.find((p) => p.pid === edited.opponentPid);
      if (!p1 || !p2) throw new Error("Players missing.");

      const challengerStartPos = p1.position;
      const opponentStartPos = p2.position;
      const shouldMove = edited.winnerId === "p1" && challengerStartPos > opponentStartPos;
      const moved = shouldMove ? applyLadderMove(s.players, p1.pid, opponentStartPos) : { players: s.players, applied: false };

      edited.challengerStartPos = challengerStartPos;
      edited.opponentStartPos = opponentStartPos;
      edited.positionPlayedFor = opponentStartPos;
      edited.ladderMoveApplied = moved.applied;

      // 6) apply ladder move positions
      s.players = s.players.map((p) => {
        const after = moved.players.find((x) => x.pid === p.pid);
        return after ? { ...p, position: after.position } : p;
      });

      // 7) add edited stats
      applyMatchDelta(edited, +1);

      // 8) update match list
      s.matches = s.matches.map((m) => (m.id === edited.id ? edited : m));

      return s;
    })();

    setState(nextState);

    try {
      await saveCloudState(pin, nextState);
      setEditOpen(false);
      setEditId(null);
    } catch (e) {
      setEditError(String(e?.message || e || "Failed to save edit to cloud."));
    }
  }


  async function actuallySaveAll(pin) {
    setError("");
    try {
      await saveCloudState(pin, state);
      setDirty(false);
    } catch (e) {
      setError(String(e?.message || e || "Failed to save to cloud."));
    }
  }

  const pinTitle =
    pinPurpose === "unlock"
      ? "Admin unlock"
      : pinPurpose === "add"
      ? "Admin PIN required to add match"
      : pinPurpose === "delete"
      ? "Admin PIN required to delete match"
      : pinPurpose === "edit"
      ? "Admin PIN required to save edit"
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
      : "PIN required to push your changes to the cloud.";

  const opponentLabel = useMemo(() => {
    const pos = clamp(asNumber(matchPos, 1), 1, playerCount);
    const p = players.find((x) => x.position === pos);
    const nm = p?.name?.trim();
    return nm ? `#${pos} (${nm})` : `#${pos}`;
  }, [matchPos, playerCount, players]);

  return (
    <div className="app">
      <style>{css}</style>

      {/* Player Results Modal */}
      <Modal
        open={playerModalOpen}
        title={(() => {
          const p = players.find((x) => x.pid === playerModalPid);
          if (!p) return "Player results";
          const base = p.name?.trim() ? p.name : "Player";
          const inactive = p.position < 1 || p.position > playerCount;
          return inactive ? `${base} (Inactive) — Results` : `${base} — Results`;
        })()}
        onClose={() => {
          setPlayerModalOpen(false);
          setPlayerModalPid(null);
        }}
        actions={
          <button
            className="btn"
            onClick={() => {
              setPlayerModalOpen(false);
              setPlayerModalPid(null);
            }}
          >
            Close
          </button>
        }
      >
        {(() => {
          const pid = playerModalPid;
          if (!pid) return <div className="hint">No player selected.</div>;

          const list = matchesView
            .filter((m) => m.challengerPid === pid || m.opponentPid === pid)
            .sort((a, b) => {
              const d = String(b.date).localeCompare(String(a.date));
              if (d !== 0) return d;
              return String(b.id).localeCompare(String(a.id));
            });

          if (list.length === 0) return <div className="hint">No matches logged for this player yet.</div>;

          const pnameBase = players.find((x) => x.pid === pid)?.name || "(Unknown)";
          const pObj = players.find((x) => x.pid === pid);
          const pname = pObj && (pObj.position < 1 || pObj.position > playerCount) ? `${pnameBase} (Inactive)` : pnameBase;

          return (
            <div className="playerMatchList">
              {list.map((m) => {
                const isChallenger = m.challengerPid === pid;
                const opponentName = isChallenger ? m.p2Name : m.p1Name;
                const didWin = (m.winnerId === "p1" && isChallenger) || (m.winnerId === "p2" && !isChallenger);
                return (
                  <div key={m.id} className="playerMatchRow">
                    <div className="playerMatchTop">
                      <div className="mono">{m.date}</div>
                      <div className={didWin ? "pillWin" : "pillLoss"}>{didWin ? "WIN" : "LOSS"}</div>
                    </div>
                    <div className="playerMatchMid">
                      <div>
                        <div className="playerMatchTitle">
                          {pname} vs {opponentName}
                        </div>
                        <div className="hint">
                          Played for #{m.positionPlayedFor} • {m.surface || "—"} • {isChallenger ? "Challenger" : "Opponent"}
                          {m.ladderMoveApplied ? " • Ladder moved" : ""}
                        </div>
                      </div>
                      <div className="mono playerMatchScore">{m.score}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </Modal>

      {/* Match added */}
      <Modal
        open={matchAddedOpen}
        title="Match added"
        onClose={() => setMatchAddedOpen(false)}
        actions={
          <button className="btn" onClick={() => setMatchAddedOpen(false)}>
            OK
          </button>
        }
      >
        <div>Saved successfully.</div>
      </Modal>

      {/* Edit match */}
      <Modal
        open={editOpen}
        title="Edit match"
        onClose={() => {
          setEditOpen(false);
          setEditId(null);
          setEditError("");
        }}
        actions={
          <>
            <button
              className="btnGhost"
              onClick={() => {
                setEditOpen(false);
                setEditId(null);
                setEditError("");
              }}
            >
              Cancel
            </button>
            <button className="btn" onClick={requestSaveEdit}>
              Save
            </button>
          </>
        }
      >
        {editError ? <div className="errorBox">{editError}</div> : null}
        <div className="formGrid" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginTop: 2 }}>
          <div>
            <div className="label">Date</div>
            <input className="textInput" type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
          </div>
          <div>
            <div className="label">Surface</div>
            <select className="textInput" value={editSurface} onChange={(e) => setEditSurface(e.target.value)}>
              {SURFACES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
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
        <div className="hint" style={{ marginTop: 10 }}>
          Saving an edit will recalculate stats and ladder moves.
        </div>
      </Modal>

      {/* PIN modal */}
      <Modal
        open={pinOpen}
        title={pinTitle}
        onClose={closePin}
        actions={
          <>
            <button className="btnGhost" onClick={closePin}>
              Cancel
            </button>
            <button className="btn" onClick={submitPin}>
              {pinPurpose === "unlock" ? "Unlock" : "Continue"}
            </button>
          </>
        }
      >
        <label className="label">Enter PIN</label>
        <input
          ref={pinRef}
          className="textInput"
          type="password"
          value={pinValue}
          onChange={(e) => setPinValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitPin();
          }}
          placeholder="••••"
        />
        {pinError ? <div className="error">{pinError}</div> : null}
        <div className="hint">{pinHint}</div>
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={deleteConfirmOpen}
        title="Are you sure?"
        onClose={() => setDeleteConfirmOpen(false)}
        actions={
          <>
            <button className="btnGhost" onClick={() => setDeleteConfirmOpen(false)}>
              No
            </button>
            <button className="btnDanger" onClick={deleteMatchConfirmed}>
              Yes, delete
            </button>
          </>
        }
      >
        <div className="hint">This removes the match and reverses its stats/ladder movement.</div>
      </Modal>

      <div className="container">
        {/* Title + actions */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="cardHeader">
            <div>
              <div className="title">Heron Tennis Summer Ladder 2026</div>
              <div className="subtitle">
                {playerCount} players • click headers to sort (display-only). Cloud synced.
                {cloudLoading ? " • Loading…" : ""}
              </div>
              {cloudError ? <div className="error">Cloud error: {cloudError}</div> : null}
              {!supabase ? <div className="error">Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY</div> : null}
            </div>
            <div className="actions">
              {locked ? (
                <button className="btn" onClick={() => openPin("unlock")}>
                  Locked — Admin unlock
                </button>
              ) : (
                <button className="btnGhost" onClick={() => setLocked(true)}>
                  Unlocked — Lock
                </button>
              )}
              <button
                className="btnGhost"
                onClick={() => {
                  setSortKey("position");
                  setSortDir("asc");
                }}
              >
                Reset sort
              </button>

              <button
                className={dirty && !locked ? "btn" : "btnGhost"}
                disabled={locked || !dirty}
                onClick={() => openPin("save")}
                title={locked ? "Unlock to save changes" : dirty ? "Save your edits to the shared ladder" : "No unsaved changes"}
              >
                Save changes
              </button>
            </div>
          </div>

          {/* Live ranking UNDER title, above table, left-to-right */}
          <div className="cardBody" style={{ paddingTop: 12 }}>
            <div className="liveHeader">
              <div>
                <div className="cardTitle">Live ranking</div>
                <div className="hint">Top 3</div>
              </div>
            </div>

            {leaderboardTop3.length === 0 ? (
              <div className="hint">Add names + matches to populate.</div>
            ) : (
              <div className="leaderRowGrid">
                <LeaderCard medal="🥇" p={leaderboardTop3[0]} />
                <LeaderCard medal="🥈" p={leaderboardTop3[1]} />
                <LeaderCard medal="🥉" p={leaderboardTop3[2]} />
              </div>
            )}
          </div>
        </div>

        {/* Main table */}
        <div className="card">
          <div className="cardHeader">
            <div>
              <div className="hint">Locked = nothing editable.</div>
            </div>
          </div>
          <div className="cardBody">
            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    {COLS.map((c) => (
                      <th key={c.key}>
                        <button className="thBtn" onClick={() => toggleSort(c.key)}>
                          {c.label}
                          {sortIndicator(c.key)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayedPlayers.map((p) => (
                    <tr key={p.pid} style={ladderRowStyle(p.position)}>
                      <td className="posCell">{p.position}</td>
                      <td>
                        {locked ? (
                          <button
                            type="button"
                            className="nameBtn"
                            style={latestResultStyle(p.pid)}
                            onClick={() => {
                              setPlayerModalPid(p.pid);
                              setPlayerModalOpen(true);
                            }}
                            title="Tap to view results"
                          >
                            {p.name || "—"}
                          </button>
                        ) : (
                          <input className="textInput" value={p.name} placeholder="Player name" onChange={(e) => updatePlayer(p.pid, "name", e.target.value)} />
                        )}
                      </td>
                      <td>
                        <StatCell locked={locked} value={p.matchesPlayed} onChange={(v) => updatePlayer(p.pid, "matchesPlayed", v)} />
                      </td>
                      <td>
                        <StatCell locked={locked} value={p.matchesWon} onChange={(v) => updatePlayer(p.pid, "matchesWon", v)} />
                      </td>
                      <td>
                        <StatCell locked={locked} value={p.setsWon} onChange={(v) => updatePlayer(p.pid, "setsWon", v)} />
                      </td>
                      <td>
                        <StatCell locked={locked} value={p.setsLost} onChange={(v) => updatePlayer(p.pid, "setsLost", v)} />
                      </td>
                      <td className="diff">{p.setDiff}</td>
                      <td>
                        <StatCell locked={locked} value={p.gamesWon} onChange={(v) => updatePlayer(p.pid, "gamesWon", v)} />
                      </td>
                      <td>
                        <StatCell locked={locked} value={p.gamesLost} onChange={(v) => updatePlayer(p.pid, "gamesLost", v)} />
                      </td>
                      <td className="diff">{p.gameDiff}</td>
                      <td>
                        <StatCell locked={locked} value={p.apr} onChange={(v) => updatePlayer(p.pid, "apr", v)} />
                      </td>
                      <td>
                        <StatCell locked={locked} value={p.may} onChange={(v) => updatePlayer(p.pid, "may", v)} />
                      </td>
                      <td>
                        <StatCell locked={locked} value={p.jun} onChange={(v) => updatePlayer(p.pid, "jun", v)} />
                      </td>
                      <td>
                        <StatCell locked={locked} value={p.jul} onChange={(v) => updatePlayer(p.pid, "jul", v)} />
                      </td>
                      <td>
                        <StatCell locked={locked} value={p.aug} onChange={(v) => updatePlayer(p.pid, "aug", v)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 14 }}>
          <div className="cardHeader">
            <div>
              <div className="cardTitle">Add Match</div>
              <div className="hint">Add/Delete/Edit require PIN. Viewers can see updates in realtime.</div>
            </div>
          </div>
          <div className="cardBody">
            {error ? <div className="errorBox">{error}</div> : null}

            <div className="formGrid">
              <div>
                <div className="label">Date</div>
                <input className="textInput" type="date" value={matchDate} onChange={(e) => setMatchDate(e.target.value)} disabled={locked} />
              </div>

              <div>
                <div className="label">Position being played for</div>
                <select className="textInput" value={matchPos} onChange={(e) => setMatchPos(e.target.value)} disabled={locked}>
                  {Array.from({ length: playerCount }, (_, i) => {
                    const pos = i + 1;
                    const p = players.find((x) => x.position === pos);
                    const nm = p?.name?.trim();
                    return (
                      <option key={pos} value={String(pos)}>
                        #{pos}{nm ? ` (${nm})` : ""}
                      </option>
                    );
                  })}
                </select>
                <div className="hint">Selected: {opponentLabel}</div>
              </div>

              <div>
                <div className="label">Challenger</div>
                <select className="textInput" value={challengerPid} onChange={(e) => setChallengerPid(e.target.value)} disabled={locked}>
                  <option value="">Select…</option>
                  {selectablePlayers.map((p) => (
                    <option key={p.pid} value={p.pid}>
                      #{p.position} — {p.name}
                    </option>
                  ))}
                </select>
                <div className="hint">Tip: add names first, then they appear here.</div>
              </div>

              <div>
                <div className="label">Surface</div>
                <select className="textInput" value={surface} onChange={(e) => setSurface(e.target.value)} disabled={locked}>
                  {SURFACES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="label">Winner</div>
                <select className="textInput" value={winner} onChange={(e) => setWinner(e.target.value)} disabled={locked}>
                  <option value="p1">{challenger?.name?.trim() ? challenger.name : "Challenger"}</option>
                  <option value="p2">{opponent?.name?.trim() ? opponent.name : "Opponent"}</option>
                </select>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="label">Score (From {challenger?.name?.trim() ? `${challenger.name}'s` : "Challenger's"} perspective)</div>
              <input
                className="textInput"
                value={score}
                onChange={(e) => setScore(e.target.value)}
                placeholder="e.g. 6-4 3-6 10-8"
                disabled={locked}
              />
              <div className="hint">Valid: 6-x, 7-5, 7-6, or match tie-break 10+ (win by 2).</div>

              {/* Button BELOW score input (per request) */}
              <button className="btn" style={{ marginTop: 10 }} onClick={requestAddMatch} disabled={locked}>
                Add match
              </button>
            </div>

            {locked ? <div className="hint" style={{ marginTop: 10 }}>Locked: nothing is editable. Admin unlock to enter results.</div> : null}

            <div className="sep" />

            <div className="cardTitle" style={{ marginBottom: 8 }}>Completed matches</div>
            {matchesView.length === 0 ? (
              <div className="hint">No matches logged yet.</div>
            ) : (
              <div className="tableWrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Played for</th>
                      <th>Challenger</th>
                      <th>Opponent</th>
                      <th>Surface</th>
                      <th>Winner</th>
                      <th>Score</th>
                      <th style={{ textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchesView.map((m) => (
                      <tr key={m.id}>
                        <td className="mono">{m.date}</td>
                        <td>#{m.positionPlayedFor}</td>
                        <td>{m.p1Name}</td>
                        <td>{m.p2Name}</td>
                        <td>{m.surface || "—"}</td>
                        <td>{m.winnerName}</td>
                        <td className="mono">{m.score}</td>
                        <td style={{ textAlign: "right" }}>
                          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                            <button className="btnGhost" disabled={locked} onClick={() => openEditMatch(m)}>
                              Edit
                            </button>
                            <button className="btnDanger" disabled={locked} onClick={() => requestDeleteMatch(m.id)}>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="sep" />

            <div className="cardTitle" style={{ marginBottom: 8 }}>Player count</div>
            <div style={{ maxWidth: 320 }}>
              <div className="label">How many players are in the ladder?</div>
              <input
                className="textInput"
                type="number"
                min={2}
                max={CAPACITY}
                value={playerCount}
                disabled={locked}
                onChange={(e) => {
                  const next = clamp(asNumber(e.target.value, DEFAULT_PLAYER_COUNT), 2, CAPACITY);
                  setDirty(true);
                  setState((prev) => ({ ...prev, playerCount: next }));
                }}
              />
              <div className="hint">Min 2, max {CAPACITY}. (Default: {DEFAULT_PLAYER_COUNT})</div>
              <div className="hint">Note: Player count changes are local until you add a “Save settings” admin action.</div>
            </div>
          </div>
        </div>

        <div className="hint" style={{ textAlign: "center", margin: "16px 0 30px" }}>
          Shared cloud storage via Supabase. Everyone sees the same ladder.
        </div>
      </div>

      <SelfTests />
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
  .subtitle { margin-top: 4px; font-size: 12px; color: var(--muted); }
  .cardTitle { font-size: 14px; font-weight: 800; }

  .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

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

  .btn:disabled, .btnGhost:disabled, .btnDanger:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

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

  .tableWrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 14px; }
  .table {
    width: 100%;
    border-collapse: collapse;
    min-width: 1100px;
    background: rgba(0,0,0,0.12);
  }

  th, td { padding: 10px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: middle; }

  th {
    text-align: left;
    font-size: 13px;
    font-weight: 900;
    color: var(--muted);
    position: sticky;
    top: 0;
    background: rgba(12, 16, 32, 0.96);
  }

  .thBtn {
    background: transparent;
    border: 0;
    color: inherit;
    font-weight: 900;
    cursor: pointer;
    padding: 0;
  }
  .thBtn:hover { text-decoration: underline; text-underline-offset: 4px; }

  .posCell { font-weight: 900; }

  .nameBtn {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    padding: 6px 8px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.02);
    color: var(--text);
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.01em;
    cursor: pointer;
    text-align: left;
  }
  .nameBtn:hover { border-color: rgba(255,255,255,0.18); }
  .nameBtn:hover { border-color: rgba(255,255,255,0.22); }

  .textInput {
    width: 100%;
    padding: 9px 10px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.06);
    color: var(--text);
    outline: none;
  }
  .textInput:focus { border-color: rgba(255,255,255,0.22); }

  /* Dropdown fix: black text on white background */
  select.textInput {
    appearance: none;
    background: #ffffff;
    color: #000000;
    border-color: rgba(0,0,0,0.20);
  }
  select.textInput:disabled { opacity: 0.6; }
  select.textInput option { background: #ffffff; color: #000000; }

  .numInput {
    width: 76px;
    padding: 7px 8px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.06);
    color: var(--text);
    outline: none;
    font-variant-numeric: tabular-nums;
  }

  .numText {
    width: 76px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    padding-right: 2px;
  }

  .diff { font-weight: 900; font-variant-numeric: tabular-nums; }
  .mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

  .formGrid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
  }
  @media (min-width: 980px) {
    .formGrid { grid-template-columns: repeat(5, 1fr); }
  }

  .label { font-size: 12px; color: var(--muted); font-weight: 800; margin-bottom: 6px; }

  .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }

  /* Live ranking layout */
  .liveHeader {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 12px;
    margin-bottom: 10px;
  }

  .leaderRowGrid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
  }

  @media (min-width: 920px) {
    .leaderRowGrid {
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
  }

  .leaderCard {
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 12px;
    background: rgba(255,255,255,0.04);
    min-height: 92px;
  }

  .leaderCard.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
  }

  .leaderMedal { font-size: 18px; }
  .leaderName {
    font-weight: 600;
    font-size: 14px;
    margin-top: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: 0.01em;
  }

  /* Make stats under live ranking clearer + rounder */
  .leaderSub {
    font-family: ui-rounded, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    font-weight: 800;
    color: rgba(255,255,255,0.78);
    font-size: 12.5px;
  }

  .leaderStats {
    font-size: 13px;
    font-weight: 600;
    color: rgba(255,255,255,0.85);
    margin-top: 8px;
  }

  .playerMatchList { display: flex; flex-direction: column; gap: 10px; }
  .playerMatchRow {
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.04);
    border-radius: 14px;
    padding: 12px;
  }
  .playerMatchTop { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .playerMatchMid { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-top: 10px; }
  .playerMatchTitle { font-weight: 900; }
  .playerMatchScore { font-weight: 900; }
  .pillWin, .pillLoss {
    font-size: 11px;
    font-weight: 900;
    letter-spacing: 0.06em;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.12);
  }
  .pillWin { background: rgba(34, 197, 94, 0.18); color: rgba(220, 255, 230, 0.95); border-color: rgba(34, 197, 94, 0.30); }
  .pillLoss { background: rgba(239, 68, 68, 0.16); color: rgba(255, 225, 225, 0.95); border-color: rgba(239, 68, 68, 0.28); }

  /* Modal */
  .modalOverlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px;
    z-index: 50;
  }
  .modalCard {
    width: min(560px, 100%);
    background: rgba(18, 24, 48, 0.98);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 16px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .modalHeader {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 14px 14px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.10);
  }
  .modalTitle { font-weight: 900; font-size: 14px; }
  .modalBody { padding: 14px; }
  .modalFooter {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 14px 14px;
    border-top: 1px solid rgba(255,255,255,0.10);
  }
  .iconBtn {
    background: transparent;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    font-size: 14px;
  }
  .iconBtn:hover { color: var(--text); }
`;
