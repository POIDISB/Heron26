import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const expectedPin = String(process.env.ADMIN_PIN || "");

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function slugify(value) {
  return (
    String(value || "season")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "season"
  );
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, {
      error: "Method not allowed",
    });
  }

  if (!supabaseUrl || !serviceKey) {
    return json(res, 500, {
      error: "Supabase server environment variables are missing.",
    });
  }

  if (!expectedPin) {
    return json(res, 500, {
      error: "ADMIN_PIN is not configured.",
    });
  }

  const { pin, action, payload = {} } = req.body || {};

  if (String(pin || "") !== expectedPin) {
    return json(res, 401, {
      error: "Incorrect admin PIN.",
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  try {
    if (action === "createSeason") {
      const name = String(payload.name || "").trim();
      const startDate = String(payload.startDate || "");
      const endDate = String(payload.endDate || "");

      if (
        !name ||
        !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
      ) {
        return json(res, 400, {
          error: "Name, start date and end date are required.",
        });
      }

      if (endDate < startDate) {
        return json(res, 400, {
          error: "End date must be after start date.",
        });
      }

      let id = `${slugify(name)}-${startDate.slice(0, 4)}`;

      const existing = await supabase
        .from("seasons")
        .select("id")
        .eq("id", id)
        .maybeSingle();

      if (existing.error) {
        throw existing.error;
      }

      if (existing.data) {
        id = `${id}-${Date.now().toString(36)}`;
      }

      const season = {
        id,
        name,
        start_date: startDate,
        end_date: endDate,
        archived: false,
      };

      const inserted = await supabase
        .from("seasons")
        .insert(season)
        .select("*")
        .single();

      if (inserted.error) {
        throw inserted.error;
      }

      const settings = [
        {
          key: `playerCount_${id}_mens`,
          value: "40",
        },
        {
          key: `playerCount_${id}_womens`,
          value: "40",
        },
      ];

      const settingResult = await supabase
        .from("settings")
        .upsert(settings, {
          onConflict: "key",
        });

      if (settingResult.error) {
        throw settingResult.error;
      }

      return json(res, 200, {
        ok: true,
        season: inserted.data,
      });
    }


    if (action === "updateSeason") {
      const seasonId = String(payload.seasonId || "");
      const name = String(payload.name || "").trim();
      const startDate = String(payload.startDate || "");
      const endDate = String(payload.endDate || "");

      if (
        !seasonId ||
        !name ||
        !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
      ) {
        return json(res, 400, {
          error: "Ladder season, name, start date and end date are required.",
        });
      }

      if (endDate < startDate) {
        return json(res, 400, {
          error: "End date must be after start date.",
        });
      }

      const result = await supabase
        .from("seasons")
        .update({
          name,
          start_date: startDate,
          end_date: endDate,
          updated_at: new Date().toISOString(),
        })
        .eq("id", seasonId)
        .select("*")
        .single();

      if (result.error) throw result.error;

      return json(res, 200, {
        ok: true,
        season: result.data,
      });
    }

    if (action === "renameSeason") {
      const seasonId = String(payload.seasonId || "");
      const name = String(payload.name || "").trim();

      if (!seasonId || !name) {
        return json(res, 400, {
          error: "Season and new name are required.",
        });
      }

      const result = await supabase
        .from("seasons")
        .update({
          name,
          updated_at: new Date().toISOString(),
        })
        .eq("id", seasonId)
        .select("*")
        .single();

      if (result.error) {
        throw result.error;
      }

      return json(res, 200, {
        ok: true,
        season: result.data,
      });
    }

    if (action === "setPublicDefault") {
      const seasonId = String(payload.seasonId || "");
      const division =
        payload.division === "womens" ? "womens" : "mens";

      const exists = await supabase
        .from("seasons")
        .select("id")
        .eq("id", seasonId)
        .maybeSingle();

      if (exists.error) {
        throw exists.error;
      }

      if (!exists.data) {
        return json(res, 404, {
          error: "Season not found.",
        });
      }

      const result = await supabase
        .from("settings")
        .upsert(
          [
            {
              key: "default_public_season",
              value: seasonId,
            },
            {
              key: "default_public_division",
              value: division,
            },
          ],
          {
            onConflict: "key",
          }
        );

      if (result.error) {
        throw result.error;
      }

      return json(res, 200, {
        ok: true,
      });
    }

    if (action === "saveState") {
      const seasonId = String(payload.seasonId || "");

      if (!seasonId) {
        return json(res, 400, {
          error: "seasonId is required.",
        });
      }

      const seasonExists = await supabase
        .from("seasons")
        .select("id")
        .eq("id", seasonId)
        .maybeSingle();

      if (seasonExists.error) {
        throw seasonExists.error;
      }

      if (!seasonExists.data) {
        return json(res, 404, {
          error: "Season not found.",
        });
      }

      const incomingPlayers = Array.isArray(payload.players)
        ? payload.players
        : [];

      const pidMap = new Map();

      for (const player of incomingPlayers) {
        const original = String(player.pid || "");

        const safePid = original.startsWith(`${seasonId}_`)
          ? original
          : `${seasonId}_${original}`;

        pidMap.set(original, safePid);
      }

      const players = incomingPlayers.map((player) => ({
        season_id: seasonId,
        pid: pidMap.get(String(player.pid || "")),
        division:
          player.division === "womens" ? "womens" : "mens",
        position: number(player.position, 1),
        name: String(player.name || ""),
        matches_played: number(player.matchesPlayed),
        matches_won: number(player.matchesWon),
        sets_won: number(player.setsWon),
        sets_lost: number(player.setsLost),
        games_won: number(player.gamesWon),
        games_lost: number(player.gamesLost),
        apr: number(player.apr),
        may: number(player.may),
        jun: number(player.jun),
        jul: number(player.jul),
        aug: number(player.aug),
        withdrawn: Boolean(
          player.withdrawn ||
            String(player.name || "").startsWith("W - ")
        ),
        updated_at: new Date().toISOString(),
      }));

      const incomingMatches = Array.isArray(payload.matches)
        ? payload.matches
        : [];

      const matches = incomingMatches.map((match) => ({
        id: String(match.id),
        season_id: seasonId,
        division:
          match.division === "womens" ? "womens" : "mens",
        date: String(match.date || ""),
        position_played_for: number(
          match.positionPlayedFor,
          1
        ),
        challenger_pid:
          pidMap.get(String(match.challengerPid || "")) ||
          String(match.challengerPid || ""),
        opponent_pid:
          pidMap.get(String(match.opponentPid || "")) ||
          String(match.opponentPid || ""),
        winner_id: match.winnerId === "p1" ? "p1" : "p2",
        score: String(match.score || ""),
        surface: String(match.surface || ""),
        challenger_name: String(
          match.challengerName || ""
        ),
        opponent_name: String(match.opponentName || ""),
        winner_name: String(
          match.winnerNameSnapshot || ""
        ),
        challenger_start_pos: number(
          match.challengerStartPos
        ),
        opponent_start_pos: number(
          match.opponentStartPos
        ),
        ladder_move_applied: Boolean(
          match.ladderMoveApplied
        ),
        updated_at: new Date().toISOString(),
      }));

      // Reconcile the season instead of deleting and rebuilding it.
      // Matches must be removed before any players they reference, while
      // players must exist before new or edited matches are upserted.
      const [existingPlayersResult, existingMatchesResult] =
        await Promise.all([
          supabase
            .from("players")
            .select("pid")
            .eq("season_id", seasonId),
          supabase
            .from("matches")
            .select("id")
            .eq("season_id", seasonId),
        ]);

      if (existingPlayersResult.error) {
        throw existingPlayersResult.error;
      }

      if (existingMatchesResult.error) {
        throw existingMatchesResult.error;
      }

      const incomingPlayerIds = new Set(
        players.map((player) => String(player.pid))
      );
      const incomingMatchIds = new Set(
        matches.map((match) => String(match.id))
      );

      const removedMatchIds = (existingMatchesResult.data || [])
        .map((row) => String(row.id))
        .filter((id) => !incomingMatchIds.has(id));

      const removedPlayerIds = (existingPlayersResult.data || [])
        .map((row) => String(row.pid))
        .filter((pid) => !incomingPlayerIds.has(pid));

      if (removedMatchIds.length) {
        const deleteRemovedMatches = await supabase
          .from("matches")
          .delete()
          .eq("season_id", seasonId)
          .in("id", removedMatchIds);

        if (deleteRemovedMatches.error) {
          throw deleteRemovedMatches.error;
        }
      }

      if (players.length) {
        const upsertPlayers = await supabase
          .from("players")
          .upsert(players, {
            onConflict: "season_id,pid",
          });

        if (upsertPlayers.error) {
          throw upsertPlayers.error;
        }
      }

      if (matches.length) {
        const upsertMatches = await supabase
          .from("matches")
          .upsert(matches, {
            onConflict: "id",
          });

        if (upsertMatches.error) {
          throw upsertMatches.error;
        }
      }

      if (removedPlayerIds.length) {
        const deleteRemovedPlayers = await supabase
          .from("players")
          .delete()
          .eq("season_id", seasonId)
          .in("pid", removedPlayerIds);

        if (deleteRemovedPlayers.error) {
          throw deleteRemovedPlayers.error;
        }
      }

      const counts = payload.playerCounts || {};

      const settingResult = await supabase
        .from("settings")
        .upsert(
          [
            {
              key: `playerCount_${seasonId}_mens`,
              value: String(number(counts.mens, 40)),
            },
            {
              key: `playerCount_${seasonId}_womens`,
              value: String(number(counts.womens, 40)),
            },
          ],
          {
            onConflict: "key",
          }
        );

      if (settingResult.error) {
        throw settingResult.error;
      }

      return json(res, 200, {
        ok: true,
        players: players.length,
        matches: matches.length,
      });
    }

    return json(res, 400, {
      error: `Unknown action: ${String(action || "")}`,
    });
  } catch (error) {
    console.error(error);

    return json(res, 500, {
      error: error?.message || "Server error",
    });
  }
}