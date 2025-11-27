// /api/opponents.js  (CommonJS - Vercel friendly)
module.exports = async (req, res) => {
  const user = (req.query.user || "_parad0xx").trim();
  const debug = req.query.debug === "1";

  const fetchJson = async (url, opts = {}) => {
    try {
      const r = await fetch(url, opts);
      const text = await r.text();
      try {
        return { ok: r.ok, json: JSON.parse(text), raw: text, status: r.status };
      } catch (e) {
        return { ok: r.ok, json: null, raw: text, status: r.status };
      }
    } catch (err) {
      return { ok: false, json: null, raw: String(err), status: 0 };
    }
  };

  try {
    // 1) Pull the user object first
    const userUrl = `https://api.mcsrranked.com/users/${encodeURIComponent(user)}`;
    const u = await fetchJson(userUrl);

    if (debug) {
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=15");
      return res.status(200).json({ userUrl, userFetch: u });
    }

    if (!u.ok || !u.json) {
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
      return res.status(200).send(`Playing vs: — | Not in a live match or user not found`);
    }

    const userObj = u.json;

    // Heuristics to find match id or embedded match object
    const tryFind = (obj, re) => {
      if (!obj || typeof obj !== "object") return undefined;
      const stack = [obj], seen = new Set();
      while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const k of Object.keys(cur)) {
          const v = cur[k];
          if (re.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "object")) return v;
          if (v && typeof v === "object") stack.push(v);
        }
      }
      return undefined;
    };

    // Common keys that might indicate current match
    let matchCandidate = userObj.currentMatch ?? userObj.match ?? userObj.currentMatchId ?? userObj.matchId ?? tryFind(userObj, /match(id|Id|_id)?$/i);

    let matchObj = null;
    let matchId = null;

    // If the user object contains an embedded match object, accept it
    if (matchCandidate && typeof matchCandidate === "object" && Array.isArray(matchCandidate.players)) {
      matchObj = matchCandidate;
      matchId = matchCandidate.id ?? matchCandidate.matchId ?? null;
    } else if (matchCandidate && (typeof matchCandidate === "string" || typeof matchCandidate === "number")) {
      matchId = String(matchCandidate);
    }

    // If still no matchId, try lookups in other user fields (sometimes there is an "inMatch" flag with match data)
    if (!matchId) {
      const maybe = tryFind(userObj, /(live|inmatch|in_match|inMatch)/i);
      if (maybe && typeof maybe === "object" && Array.isArray(maybe.players)) {
        matchObj = maybe;
        matchId = maybe.id ?? maybe.matchId ?? null;
      }
    }

    // If we have a matchId, fetch the match endpoint
    if (!matchObj && matchId) {
      const mUrl = `https://api.mcsrranked.com/matches/${encodeURIComponent(matchId)}`;
      const m = await fetchJson(mUrl);
      if (m.ok && m.json) matchObj = m.json;
    }

    // If still no match object, try to search recent matches for the user and find one with "live" / "in_progress" status
    if (!matchObj) {
      // Some APIs provide recentMatches or matches on the user object
      const recent = userObj.recentMatches ?? userObj.matches ?? tryFind(userObj, /matches?$/i);
      if (Array.isArray(recent) && recent.length) {
        // find first match object with status that looks live
        matchObj = recent.find(m => m && typeof m === "object" && /live|in_progress|running/i.test(String(m.status || m.state || m.stage || "")));
        if (!matchObj) {
          // fallback: take the most recent match if it contains players and appears recent
          matchObj = recent.find(m => m && typeof m === "object" && Array.isArray(m.players));
        }
      }
    }

    // Final fallback: try global matches endpoint (best-effort; may fail or be rate-limited)
    if (!matchObj) {
      // attempt to hit a "recent live matches" endpoint and find a match containing our user
      const listUrl = `https://api.mcsrranked.com/matches/recent?limit=10`;
      const list = await fetchJson(listUrl);
      if (list.ok && Array.isArray(list.json)) {
        matchObj = list.json.find(m => Array.isArray(m.players) && m.players.some(p => String(p.name || p.player || p.username).toLowerCase() === user.toLowerCase()));
      } else if (list.ok && list.json && Array.isArray(list.json.matches)) {
        matchObj = list.json.matches.find(m => Array.isArray(m.players) && m.players.some(p => String(p.name || p.player || p.username).toLowerCase() === user.toLowerCase()));
      }
    }

    if (!matchObj || !Array.isArray(matchObj.players)) {
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
      return res.status(200).send(`Playing vs: — | Not in a live match`);
    }

    // Find our player entry in the players list
    const lowerUser = user.toLowerCase();
    const me = matchObj.players.find(p => {
      const nm = String(p.name ?? p.username ?? p.player ?? "").toLowerCase();
      if (!nm) return false;
      if (nm === lowerUser) return true;
      // some APIs prefix usernames with @ or _
      return nm.replace(/^@|^_+/, "") === lowerUser.replace(/^@|^_+/, "");
    });

    // If can't find our player, try to match by uuid/steamId etc (common fields)
    const meById = !me && (userObj.id || userObj.uuid || userObj.uuidRaw) ? matchObj.players.find(p => {
      if (!p) return false;
      return [p.id, p.uuid, p.playerId, p.steamId].some(x => x && String(x) === String(userObj.id));
    }) : null;
    const playerObj = me || meById;

    if (!playerObj) {
      // still not found — but we can try to list all players except names that look like the user
      // fallback: assume it's a match we are interested in but our username differs; then treat everyone as opponents except exact matches to user object fields
    }

    // Build opponents list: exclude self by name or by team if possible
    const selfName = (playerObj && (playerObj.name || playerObj.username || playerObj.player)) ? String(playerObj.name || playerObj.username || playerObj.player) : null;
    const selfTeam = playerObj && (playerObj.team ?? playerObj.side ?? playerObj.group ?? null);

    const opponents = matchObj.players.filter(p => {
      if (!p) return false;
      const nm = String(p.name ?? p.username ?? p.player ?? "");
      if (!nm) return false;
      if (selfName && nm.toLowerCase() === String(selfName).toLowerCase()) return false;
      // if teams exist, filter teammates out
      if (selfTeam != null && (p.team ?? p.side ?? p.group ?? null) != null) {
        return String(p.team ?? p.side ?? p.group) !== String(selfTeam);
      }
      // otherwise, if we couldn't identify our player, assume opponents are all others
      if (selfName) return true;
      // if we couldn't find self at all, treat everyone as opponent (but we'll still remove exact user matches)
      return nm.toLowerCase() !== lowerUser;
    });

    if (opponents.length === 0) {
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
      return res.status(200).send(`Playing vs: — | Opponents not found`);
    }

    // ---------- reuse previous Elo->Tier mapping logic ----------
    const tierThresholds = [
      { name: "Coal", min: -Infinity, max: 599 },
      { name: "Iron", min: 600, max: 899 },
      { name: "Gold", min: 900, max: 1199 },
      { name: "Emerald", min: 1200, max: 1399 },
      { name: "Diamond", min: 1400, max: 1599 },
      { name: "Netherite", min: 1600, max: Infinity },
    ];

    const mapEloToTierAndDiv = (e) => {
      if (e === null || e === undefined || typeof e !== "number") return null;
      const tier = tierThresholds.find(t => e >= t.min && e <= t.max);
      if (!tier) return null;
      const low = Math.max(tier.min, 0);
      const high = tier.max === Infinity ? (low + 600) : tier.max;
      const size = Math.max(1, Math.floor((high - low + 1) / 3));
      const pos = Math.max(0, Math.min(2, Math.floor((e - low) / size)));
      const div = ["I", "II", "III"][pos] || "";
      return `${tier.name}${div ? " " + div : ""}`;
    };

    // helper to find numeric elo inside a player object (robust)
    const extractElo = (p) => {
      if (!p) return null;
      const cand = p.eloRate ?? p.elo ?? p.rating ?? tryFind(p, /elo|rating|mmr|skill/i);
      if (cand == null) return null;
      const num = Number(cand);
      return Number.isFinite(num) ? Math.round(num) : null;
    };

    const extractRankText = (p) => {
      if (!p) return null;
      const rawRank = p.rank ?? p.rankText ?? tryFind(p, /rank|division|tier/i);
      if (rawRank == null) return null;
      if (typeof rawRank === "string" && rawRank.trim()) return rawRank;
      if (typeof rawRank === "number") {
        // if it's small and looks like a division/placement show it; otherwise ignore
        if (rawRank <= 50) return String(rawRank);
        return null;
      }
      return null;
    };

    // Format opponents into strings
    const parts = opponents.map(o => {
      const name = String(o.name ?? o.username ?? o.player ?? "Unknown");
      const elo = extractElo(o);
      let rankText = extractRankText(o);

      // Prefer computed tier from Elo if available
      const computed = mapEloToTierAndDiv(typeof elo === "number" ? elo : null);
      if (computed) rankText = computed;

      const eloText = (elo === null || elo === undefined) ? "—" : String(elo);
      if (!rankText) rankText = "Unranked";
      return `${name} — ${eloText} Elo (${rankText})`;
    });

    // Limit length — chat will like shorter replies. If many opponents, show first 6.
    const limited = parts.slice(0, 6);
    const more = parts.length > limited.length ? ` +${parts.length - limited.length} more` : "";

    // Cache a little to avoid hammering the MCSR API when used from chatbots
    res.setHeader("Cache-Control", "s-maxage=8, stale-while-revalidate=30");
    return res.status(200).send(`Playing vs: ${limited.join(", ")}${more}`);
  } catch (err) {
    console.error("[mcsr-opponents] error:", err);
    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
    return res.status(500).send("Playing vs: — | Error");
  }
};
