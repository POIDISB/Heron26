import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  try {
    const { pin, action, payload } = req.body || {};

    if (!pin || pin !== process.env.ADMIN_PIN) {
      return res.status(401).json({ error: "Bad PIN" });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing Supabase server environment variables" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    if (action !== "saveState") {
      return res.status(400).json({ error: "Unknown action" });
    }

    const { players, matches, playerCounts } = payload || {};

    if (!Array.isArray(players) || !Array.isArray(matches) || !playerCounts) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    // ----------------------------
    // Deduplicate incoming players
    // ----------------------------
    const playerMap = new Map();
    for (const p of players) {
      const pid = String(p?.pid || "").trim();
      if (!pid) continue;

      playerMap.set(pid, {
        pid,
        division: String(p.division || "mens"),
        position: Number(p.position || 0),
        name: String(p.name || ""),
        matches_played: Number(p.matchesPlayed || 0),
        matches_won: Number(p.matchesWon || 0),
        sets_won: Number(p.setsWon || 0),
        sets_lost: Number(p.setsLost || 0),
        games_won: Number(p.gamesWon || 0),
        games_lost: Number(p.gamesLost || 0),
        apr: Number(p.apr || 0),
        may: Number(p.may || 0),
        jun: Number(p.jun || 0),
        jul: Number(p.jul || 0),
        aug: Number(p.aug || 0),
        updated_at: new Date().toISOString(),
      });
    }
    const pRows = Array.from(playerMap.values());
    const incomingPlayerIds = pRows.map((p) => p.pid);

    // ----------------------------
    // Deduplicate incoming matches
    // ----------------------------
    const matchMap = new Map();
    for (const m of matches) {
      const id = String(m?.id || "").trim();
      if (!id) continue;

      matchMap.set(id, {
        id,
        division: String(m.division || "mens"),
        date: String(m.date || ""),
        position_played_for: Number(m.positionPlayedFor || 1),
        challenger_pid: String(m.challengerPid || ""),
        opponent_pid: String(m.opponentPid || ""),
        winner_id: String(m.winnerId || "p2"),
        score: String(m.score || ""),
        surface: String(m.surface || ""),
        challenger_start_pos: Number(m.challengerStartPos || 0),
        opponent_start_pos: Number(m.opponentStartPos || 0),
        ladder_move_applied: Boolean(m.ladderMoveApplied),
      });
    }
    const mRows = Array.from(matchMap.values());
    const incomingMatchIds = mRows.map((m) => m.id);

    // ----------------------------
    // Upsert players
    // ----------------------------
    if (pRows.length > 0) {
      const { error: pErr } = await supabase
        .from("players")
        .upsert(pRows, { onConflict: "pid" });

      if (pErr) {
        return res.status(500).json({ error: `Players save failed: ${pErr.message}` });
      }
    }

    // ----------------------------
    // Delete players not in payload
    // ----------------------------
    const { data: existingPlayers, error: existingPlayersErr } = await supabase
      .from("players")
      .select("pid");

    if (existingPlayersErr) {
      return res.status(500).json({ error: `Failed to read existing players: ${existingPlayersErr.message}` });
    }

    const existingPlayerIds = (existingPlayers || []).map((p) => String(p.pid));
    const playerIdsToDelete = existingPlayerIds.filter((pid) => !incomingPlayerIds.includes(pid));

    if (playerIdsToDelete.length > 0) {
      const { error: delPlayersErr } = await supabase
        .from("players")
        .delete()
        .in("pid", playerIdsToDelete);

      if (delPlayersErr) {
        return res.status(500).json({ error: `Players delete failed: ${delPlayersErr.message}` });
      }
    }

    // ----------------------------
    // Upsert matches
    // ----------------------------
    if (mRows.length > 0) {
      const { error: mErr } = await supabase
        .from("matches")
        .upsert(mRows, { onConflict: "id" });

      if (mErr) {
        return res.status(500).json({ error: `Matches save failed: ${mErr.message}` });
      }
    }

    // ----------------------------
    // Delete matches not in payload
    // ----------------------------
    const { data: existingMatches, error: existingMatchesErr } = await supabase
      .from("matches")
      .select("id");

    if (existingMatchesErr) {
      return res.status(500).json({ error: `Failed to read existing matches: ${existingMatchesErr.message}` });
    }

    const existingMatchIds = (existingMatches || []).map((m) => String(m.id));
    const matchIdsToDelete = existingMatchIds.filter((id) => !incomingMatchIds.includes(id));

    if (matchIdsToDelete.length > 0) {
      const { error: delMatchesErr } = await supabase
        .from("matches")
        .delete()
        .in("id", matchIdsToDelete);

      if (delMatchesErr) {
        return res.status(500).json({ error: `Matches delete failed: ${delMatchesErr.message}` });
      }
    }

    // ----------------------------
    // Save both player counts
    // ----------------------------
    const settingsRows = [
      {
        key: "playerCount_mens",
        value: Number(playerCounts.mens || 40),
        updated_at: new Date().toISOString(),
      },
      {
        key: "playerCount_womens",
        value: Number(playerCounts.womens || 40),
        updated_at: new Date().toISOString(),
      },
    ];

    const { error: sErr } = await supabase
      .from("settings")
      .upsert(settingsRows, { onConflict: "key" });

    if (sErr) {
      return res.status(500).json({ error: `Settings save failed: ${sErr.message}` });
    }

    return res.json({
      ok: true,
      playersSaved: pRows.length,
      matchesSaved: mRows.length,
      playersDeleted: playerIdsToDelete.length,
      matchesDeleted: matchIdsToDelete.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}