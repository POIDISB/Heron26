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
const CAPACITY = 60;
const SURFACES = ["Clay", "Indoor", "Outdoor Hard Court"];
const DIVISIONS = [
  { key: "mens", label: "Men's" },
  { key: "womens", label: "Women's" },
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
      <div className="leaderStats">
        <div>W: {p.matchesWon}</div>
        <div>
          SD: {p.setDiff} • GD: {p.gameDiff}
        </div>
      </div>
    </div>
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

async function fetchCloudState() {
  if (!supabase) throw new Error("Supabase client not configured. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");

  const [pRes, mRes, sRes] = await Promise.all([
    supabase.from("players").select("*").order("division", { ascending: true }).order("position", { ascending: true }),
    supabase.from("matches").select("*").order("created_at", { ascending: false }),
    supabase.from("settings").select("*").in("key", ["playerCount_mens", "playerCount_womens"]),
  ]);

  if (pRes.error) throw new Error(pRes.error.message);
  if (mRes.error) throw new Error(mRes.error.message);
  if (sRes.error) throw new Error(sRes.error.message);

  const state = defaultState();

  for (const division of ["mens", "womens"]) {
    const playersForDivision = (pRes.data || []).filter((r) => String(r.division || "mens") === division);
    const byPos = new Map(playersForDivision.map((row) => [Number(row.position), row]));
    const players = [];

    for (let pos = 1; pos <= CAPACITY; pos++) {
      const row = byPos.get(pos);
      if (!row) {
        players.push(createEmptyPlayer(pos, division));
        continue;
      }
      players.push({
        ...createEmptyPlayer(pos, division),
        pid: String(row.pid ?? `${division}_p${pos}`),
        division,
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

    const settingsRow = (sRes.data || []).find((x) => x.key === `playerCount_${division}`);
    state[division] = {
      playerCount: clamp(asNumber(settingsRow?.value ?? DEFAULT_PLAYER_COUNT, DEFAULT_PLAYER_COUNT), 2, CAPACITY),
      players,
      matches: (mRes.data || [])
        .filter((m) => String(m.division || "mens") === division)
        .map((row) => ({
          id: String(row.id),
          division,
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
        })),
    };
  }

  return state;
}

async function saveCloudState(pin, fullState) {
  const payload = {
    playerCounts: {
      mens: fullState.mens.playerCount,
      womens: fullState.womens.playerCount,
    },
    players: [...fullState.mens.players, ...fullState.womens.players],
    matches: [...fullState.mens.matches, ...fullState.womens.matches],
  };

  const res = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin, action: "saveState", payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Failed to save.");
  return data;
}

export default function App() {
  const [state, setState] = useState(() => defaultState());
  const [activeDivision, setActiveDivision] = useState("mens");
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);

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

  const [dropPid, setDropPid] = useState("");
  const [withdrawPid, setWithdrawPid] = useState("");

  const [matchAddedOpen, setMatchAddedOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState(null);

  const [playerModalOpen, setPlayerModalOpen] = useState(false);
  const [playerModalPid, setPlayerModalPid] = useState(null);

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

    const channel = supabase
      .channel("heron-ladder")
      .on("postgres_changes", { event: "*", schema: "public", table: "players" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, () => load())
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    setWinner("p2");
    setMatchPos("1");
    setChallengerPid("");
    setScore("");
    setError("");
  }, [activeDivision]);

  useEffect(() => {
    const mp = clamp(asNumber(matchPos, 1), 1, playerCount);
    if (String(mp) !== matchPos) setMatchPos(String(mp));
  }, [playerCount, matchPos]);

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

  const visiblePlayers = useMemo(() => players.filter((p) => p.position >= 1 && p.position <= playerCount), [players, playerCount]);

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
        .filter((p) => String(p.name || "").trim().length > 0)
        .sort((a, b) => a.position - b.position),
    [players, playerCount]
  );

  const leaderboardTop3 = useMemo(() => {
    const named = calculatedPlayers.filter((p) => String(p.name || "").trim().length > 0);
    return [...named].sort((a, b) => a.position - b.position).slice(0, 3);
  }, [calculatedPlayers]);

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
      await saveCloudState(pin, nextState);
      setDirty(false);
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
    let nextPlayers = current.players;

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
      await saveCloudState(pin, nextState);
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
      await saveCloudState(pin, nextState);
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
      await saveCloudState(pin, state);
      setDirty(false);
    } catch (e) {
      setError(String(e?.message || e || "Failed to save to cloud."));
    }
  }

  function isWithdrawnPlayer(p) {
    return String(p?.name || "").startsWith("W - ");
  }

  function movePlayerDownByPlaces(sourcePlayers, pid, places) {
    const target = sourcePlayers.find((p) => p.pid === pid);
    if (!target) return sourcePlayers;
    const oldPos = target.position;
    const activeMax = playerCount;
    const newPos = clamp(oldPos + places, 1, activeMax);
    if (newPos === oldPos) return sourcePlayers;

    return sourcePlayers.map((p) => {
      if (p.pid === pid) return { ...p, position: newPos };
      if (p.position > oldPos && p.position <= newPos) return { ...p, position: p.position - 1 };
      return p;
    });
  }

  function movePlayerToBottom(sourcePlayers, pid) {
    const target = sourcePlayers.find((p) => p.pid === pid);
    if (!target) return sourcePlayers;
    const oldPos = target.position;
    const newPos = playerCount;
    if (newPos === oldPos) return sourcePlayers;

    return sourcePlayers.map((p) => {
      if (p.pid === pid) return { ...p, position: newPos };
      if (p.position > oldPos && p.position <= newPos) return { ...p, position: p.position - 1 };
      return p;
    });
  }

  function makeAdminLog(player, message) {
    return {
      id: `admin_${uid()}`,
      division: activeDivision,
      date: formatDateISO(new Date()),
      positionPlayedFor: player.position,
      challengerPid: player.pid,
      opponentPid: player.pid,
      winnerId: "p2",
      score: `ADMIN: ${message}`,
      surface: "Admin",
      challengerStartPos: player.position,
      opponentStartPos: player.position,
      ladderMoveApplied: false,
    };
  }

  async function actuallyDropThreePlaces(pin) {
    setError("");
    if (locked) return setError("Locked: Admin unlock required.");
    const player = players.find((p) => p.pid === dropPid);
    if (!player) return setError("Choose a player to drop 3 places.");
    if (player.position >= playerCount) return setError("That player is already at the bottom of the active ladder.");

    const message = `${player.name || "Player"} moved down 3 places for not playing a game in 1 month.`;
    const nextPlayers = movePlayerDownByPlaces(current.players, player.pid, 3);
    const nextState = {
      ...state,
      [activeDivision]: {
        ...current,
        players: nextPlayers,
        matches: [makeAdminLog(player, message), ...current.matches],
      },
    };

    setState(nextState);
    setDirty(true);
    try {
      await saveCloudState(pin, nextState);
      setDirty(false);
      setDropPid("");
    } catch (e) {
      setError(String(e?.message || e || "Failed to save drop action to cloud."));
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
      return { ...p, name: withdrawnName };
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
      await saveCloudState(pin, nextState);
      setDirty(false);
      setWithdrawPid("");
    } catch (e) {
      setError(String(e?.message || e || "Failed to save withdraw action to cloud."));
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
      : "PIN required to push your changes to the cloud.";

  const opponentLabel = useMemo(() => {
    const pos = clamp(asNumber(matchPos, 1), 1, playerCount);
    const p = players.find((x) => x.position === pos);
    const nm = p?.name?.trim();
    return nm ? `#${pos} (${nm})` : `#${pos}`;
  }, [matchPos, playerCount, players]);

  const divisionLabel = activeDivision === "mens" ? "Men's" : "Women's";

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
          return inactive ? `${base} (Inactive) — Results` : `${base} — Results`;
        })()}
        onClose={() => {
          setPlayerModalOpen(false);
          setPlayerModalPid(null);
        }}
        actions={<button className="btn" onClick={() => { setPlayerModalOpen(false); setPlayerModalPid(null); }}>Close</button>}
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
            <div className="playerMatchList mobileSpacious">
              {list.map((m) => {
                const isChallenger = m.challengerPid === pid;
                const opponentName = isChallenger ? m.p2Name : m.p1Name;
                const didWin = (m.winnerId === "p1" && isChallenger) || (m.winnerId === "p2" && !isChallenger);
                return (
                  <div key={m.id} className="playerMatchRow roomy">
                    <div className="playerMatchTop">
                      <div className="mono">{m.date}</div>
                      <div className={didWin ? "pillWin" : "pillLoss"}>{didWin ? "WIN" : "LOSS"}</div>
                    </div>
                    <div className="playerMatchMid stackedMobile">
                      <div>
                        <div className="playerMatchTitle">{pname} vs {opponentName}</div>
                        <div className="hint">
                          {isChallenger ? `Challenging for Position #${m.positionPlayedFor}` : `Defending Position #${m.positionPlayedFor}`} • {m.surface || "—"}
                          {m.ladderMoveApplied ? " • Ladder moved" : ""}
                        </div>
                      </div>
                      <div className="mono playerMatchScore">{formatScore(m.score)}</div>
                    </div>
                  </div>
                );
              })}
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
              <div className="title">Heron Tennis Summer Ladder 2026</div>
              <div className="subtitle">
                {divisionLabel} ladder • {playerCount} players • Cloud synced.
                {cloudLoading ? " • Loading…" : ""}
              </div>
              {cloudError ? <div className="error">Cloud error: {cloudError}</div> : null}
              {!supabase ? <div className="error">Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY</div> : null}
            </div>
            <div className="actions mobileActions">
              <div className="segControl fullOnMobile">
                {DIVISIONS.map((d) => (
                  <button key={d.key} className={activeDivision === d.key ? "segBtn active" : "segBtn"} onClick={() => setActiveDivision(d.key)}>
                    {d.label}
                  </button>
                ))}
              </div>
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
            {leaderboardTop3.length === 0 ? <div className="hint">Add names + matches to populate.</div> : <div className="leaderRowGrid"><LeaderCard medal="🥇" p={leaderboardTop3[0]} /><LeaderCard medal="🥈" p={leaderboardTop3[1]} /><LeaderCard medal="🥉" p={leaderboardTop3[2]} /></div>}
          </div>
        </div>

        <div className="card" ref={ladderRef}>
          <div className="cardHeader"><div><div className="hint">Locked = nothing editable.</div></div></div>
          <div className="cardBody">
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
                        <th>Date</th><th>Played for</th><th>Challenger</th><th>Opponent</th><th>Surface</th><th>Winner</th><th>Score</th><th style={{ textAlign: "right" }}>Actions</th>
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
                          <td style={{ textAlign: "right" }}>
                            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                              <button className="btnGhost" disabled={locked} onClick={() => openEditMatch(m)}>Edit</button>
                              <button className="btnDanger" disabled={locked} onClick={() => requestDeleteMatch(m.id)}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="sep" />

            <div className="managementGrid">
              <div className="managementBox">
                <div className="cardTitle">No games played in 1 month</div>
                <div className="hint">Choose a player and move them down 3 places in the {divisionLabel} ladder.</div>
                <select className="textInput tallOnMobile" value={dropPid} onChange={(e) => setDropPid(e.target.value)} disabled={locked}>
                  <option value="">Select player…</option>
                  {selectablePlayers.map((p) => (
                    <option key={p.pid} value={p.pid}>
                      #{p.position} — {p.name}
                    </option>
                  ))}
                </select>
                <button className="btn fullWidthOnMobile" disabled={locked || !dropPid} onClick={() => openPin("drop3")}>
                  Drop 3 places
                </button>
              </div>

              <div className="managementBox">
                <div className="cardTitle">Withdraw player</div>
                <div className="hint">Move a player to the bottom, mark them with W, and grey out the row.</div>
                <select className="textInput tallOnMobile" value={withdrawPid} onChange={(e) => setWithdrawPid(e.target.value)} disabled={locked}>
                  <option value="">Select player…</option>
                  {selectablePlayers.map((p) => (
                    <option key={p.pid} value={p.pid}>
                      #{p.position} — {p.name}
                    </option>
                  ))}
                </select>
                <button className="btnDanger fullWidthOnMobile" disabled={locked || !withdrawPid} onClick={() => openPin("withdraw")}>
                  Withdraw
                </button>
              </div>
            </div>

            <div className="sep" />
            <div className="cardTitle" style={{ marginBottom: 8 }}>Player count</div>
            <div className="mobileOnly collapsibleWrap">
              <button className="collapseBtn" onClick={() => setMobileSettingsOpen((v) => !v)}>
                {mobileSettingsOpen ? "Hide player count" : "Show player count"}
              </button>
            </div>
            <div className={mobileSettingsOpen ? "sectionOpen" : "sectionClosedMobileOnly"}>
              <div style={{ maxWidth: 320 }}>
                <div className="label">How many players are in the {divisionLabel} ladder?</div>
                <input className="textInput tallOnMobile" type="number" min={2} max={CAPACITY} value={playerCount} disabled={locked} onChange={(e) => { const next = clamp(asNumber(e.target.value, DEFAULT_PLAYER_COUNT), 2, CAPACITY); setDirty(true); patchCurrentDivision((divisionState) => ({ ...divisionState, playerCount: next })); }} />
                <div className="hint">Min 2, max {CAPACITY}. (Default: {DEFAULT_PLAYER_COUNT})</div>
              </div>
            </div>
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

  .leaderCard {
    border: 1px solid var(--border); border-radius: 14px; padding: 12px; background: rgba(255,255,255,0.04); min-height: 92px;
  }
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
