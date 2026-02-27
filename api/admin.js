import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { pin, action, payload } = req.body || {};
    if (!pin || pin !== process.env.ADMIN_PIN) return res.status(401).json({ error: "Bad PIN" });

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // action router
    if (action === "saveState") {
      // payload = { players, matches, playerCount }
      const { players, matches, playerCount } = payload || {};
      if (!Array.isArray(players) || !Array.isArray(matches)) {
        return res.status(400).json({ error: "Invalid payload" });
      }

      // Upsert players
      const pRows = players.map((p) => ({
        pid: String(p.pid),
        position: Number(p.position),
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
      }));

      const { error: pErr } = await supabase.from("players").upsert(pRows, { onConflict: "pid" });
      if (pErr) return res.status(500).json({ error: pErr.message });

      // Upsert matches
      const mRows = matches.map((m) => ({
        id: String(m.id),
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
      }));

      const { error: mErr } = await supabase.from("matches").upsert(mRows, { onConflict: "id" });
      if (mErr) return res.status(500).json({ error: mErr.message });

      // Save playerCount
      const { error: sErr } = await supabase
        .from("settings")
        .upsert({ key: "playerCount", value: playerCount }, { onConflict: "key" });

      if (sErr) return res.status(500).json({ error: sErr.message });

      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}