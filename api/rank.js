// /api/richrank.js  (CommonJS - Vercel friendly)
module.exports = async (req, res) => {
  const user = (req.query.user || "_parad0xx").trim();
  const debug = req.query.debug === "1";

  // small safe fetch wrapper (no timeout here — Vercel handles it)
  const fetchJson = async (url) => {
    try {
      const r = await fetch(url);
      const txt = await r.text();
      try { return { ok: r.ok, status: r.status, json: JSON.parse(txt), raw: txt }; }
      catch (e) { return { ok: r.ok, status: r.status, json: null, raw: txt }; }
    } catch (err) {
      return { ok: false, status: 0, json: null, raw: String(err) };
    }
  };

  // helpers
  const mapEloToTierAndDiv = (e) => {
    if (e == null || typeof e !== "number") return null;
    const tiers = [
      { name: "Coal", min: -Infinity, max: 599 },
      { name: "Iron", min: 600, max: 899 },
      { name: "Gold", min: 900, max: 1199 },
      { name: "Emerald", min: 1200, max: 1399 },
      { name: "Diamond", min: 1400, max: 1599 },
      { name: "Netherite", min: 1600, max: Infinity },
    ];
    const tier = tiers.find(t => e >= t.min && e <= t.max);
    if (!tier) return null;
    const low = Math.max(tier.min, 0);
    const high = (tier.max === Infinity) ? (low + 600) : tier.max;
    const size = Math.max(1, Math.floor((high - low + 1) / 3));
    const pos = Math.max(0, Math.min(2, Math.floor((e - low) / size)));
    const div = ["I", "II", "III"][pos] || "";
    return `${tier.name}${div ? " " + div : ""}`;
  };

  const fmtPercent = (n, d, places = 1) => {
    if (d === 0 || d == null || n == null) return "—";
    const p = (n / d) * 100;
    return `${p.toFixed(places)}%`;
  };

  // Try to interpret a time value (various possible units) to mm:ss (or mm:ss.s if requested)
  const formatTimeSmart = (raw, showTenths = false) => {
    if (raw == null) return "—";
    let v = Number(raw);
    if (!Number.isFinite(v)) return "—";

    // Candidate interpretations in milliseconds
    const candidates = [
      v,            // assume ms
      v / 1000,     // assume centiseconds -> as seconds (if raw was centis) -> then *1000 to ms
      v / 1000 / 1000, // assume (unlikely)
      v * 1,        // placeholder
    ];

    // Better approach: attempt units to produce reasonable minute ranges (0.5s .. 200 minutes)
    const tryUnits = [
      1,        // treat as milliseconds
      0.001,    // treat as micro -> not likely
      0.01,     // treat as centiseconds -> multiply by 10 to get ms? we'll test below differently
      0.001,    // fallback
    ];

    const toMinutes = (ms) => ms / 60000;
    // We'll test interpretations: raw as ms, raw as centiseconds, raw as seconds
    const interpretations = [
      { ms: v, label: "ms" },
      { ms: v * 10, label: "centis->ms" },    // if raw in centiseconds (e.g. 1064686 centis -> 10646860 ms)
      { ms: v, label: "seconds->ms", convert: false }, // raw actually seconds (unlikely)
      { ms: v / 1000, label: "micro->ms" },
      { ms: v / 1000, label: "unknown" },
    ];

    // more pragmatic: try three modes: treat as ms, treat as seconds, treat as centis
    const tries = [
      { ms: v, mode: "ms" },
      { ms: v * 1000, mode: "s->ms" },    // if raw was seconds (1 -> 1000 ms)
      { ms: v * 10, mode: "centis->ms" }, // if raw was centiseconds (100 -> 1000 ms)
    ];

    // choose first interpretation that gives a minutes value in reasonable [0.0167 (1s) .. 240 (4h)] range
    let chosen = null;
    for (const t of tries) {
      const mins = t.ms / 60000;
      if (mins >= 0.0167 && mins <= 240) { chosen = t.ms; break; }
    }
    if (chosen == null) {
      // fallback: if original seems already small (<1e6) treat as ms
      chosen = (v < 1e8) ? v : v / 1000;
    }

    const ms = Math.round(chosen);
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const tenths = Math.floor((ms % 1000) / 100);
    if (showTenths) return `${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}.${tenths}`;
    return `${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
  };

  try {
    const url = `https://api.mcsrranked.com/users/${encodeURIComponent(user)}`;
    const fetched = await fetchJson(url);

    if (debug) {
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=15");
      return res.status(200).json({ url, fetched });
    }

    if (!fetched.ok || !fetched.json || !fetched.json.data) {
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
      return res.status(200).send(`${user} Elo: — | Rank: Unranked`);
    }

    const data = fetched.json.data;

    const nick = data.nickname ?? user;
    const eloRaw = data.eloRate ?? data.elo ?? null;
    const elo = (eloRaw == null) ? null : (Number.isFinite(Number(eloRaw)) ? Math.round(Number(eloRaw)) : null);

    const peak = (data.seasonResult && (data.seasonResult.highest ?? null)) ?? null;
    const peakText = peak != null ? String(peak) : "—";

    // leaderboard/global rank if present (eloRank)
    const globalRank = data.eloRank ?? null;

    // wins/loses and played
    // prefer statistics.total if present, else statistics.season
    const statsTotal = (data.statistics && data.statistics.total) ? data.statistics.total : (data.statistics && data.statistics.season ? data.statistics.season : null);
    const wins = statsTotal?.wins?.ranked ?? statsTotal?.wins ?? null;
    const loses = statsTotal?.loses?.ranked ?? statsTotal?.loses ?? null;
    const played = statsTotal?.playedMatches?.ranked ?? statsTotal?.playedMatches ?? null;

    // Win percentage
    let winPercent = "—";
    if (wins != null && loses != null) {
      const w = Number(wins), l = Number(loses);
      const denom = w + l;
      if (denom > 0) winPercent = ((w / denom) * 100).toFixed(1) + "%";
    } else if (wins != null && played != null) {
      const w = Number(wins), p = Number(played);
      if (p > 0) winPercent = ((w / p) * 100).toFixed(1) + "%";
    }

    // best PB and average completion times (if available)
    // PB: statistics.total.bestTime.ranked OR achievements.display bestTime.value
    let pbRaw = null;
    if (statsTotal?.bestTime?.ranked != null) pbRaw = statsTotal.bestTime.ranked;
    else if (Array.isArray(data.achievements?.display)) {
      const bt = data.achievements.display.find(x => x.id === "bestTime");
      if (bt && bt.value != null) pbRaw = bt.value;
    }
    // avg: completionTime / completions
    let avgRaw = null;
    const completionTime = statsTotal?.completionTime?.ranked ?? statsTotal?.completionTime ?? null;
    const completions = statsTotal?.completions?.ranked ?? statsTotal?.completions ?? null;
    if (completionTime != null && completions != null && Number(completions) > 0) {
      avgRaw = Number(completionTime) / Number(completions);
    }

    // forfeits -> ff rate
    const forfeits = statsTotal?.forfeits?.ranked ?? statsTotal?.forfeits ?? null;
    let ffRateText = "—";
    if (forfeits != null && played != null && Number(played) > 0) {
      ffRateText = ((Number(forfeits) / Number(played)) * 100).toFixed(1) + "%";
    } else if (forfeits != null && wins != null && loses != null) {
      const denom = Number(wins) + Number(loses);
      if (denom > 0) ffRateText = ((Number(forfeits) / denom) * 100).toFixed(1) + "%";
    }

    // phase points
    const phasePoints = (data.seasonResult && data.seasonResult.last && Number.isFinite(Number(data.seasonResult.last.phasePoint))) ? Number(data.seasonResult.last.phasePoint) : (data.seasonResult?.last?.phasePoint ?? 0);

    // decay info (timestamp.nextDecay is unix timestamp probably; if null show placeholder)
    let decayText = "—";
    const nextDecay = data.timestamp?.nextDecay ?? null;
    if (nextDecay != null) {
      // nextDecay might be unix seconds — compute diff
      const nowSec = Math.floor(Date.now() / 1000);
      const rawSec = Number(nextDecay);
      if (Number.isFinite(rawSec) && rawSec > nowSec) {
        const diff = rawSec - nowSec;
        const days = Math.floor(diff / 86400);
        const hours = Math.floor((diff % 86400) / 3600);
        decayText = `${days}d${hours}h`;
      } else {
        decayText = "soon";
      }
    } else {
      decayText = "—";
    }

    // Format PB and avg using a smart formatter (best-effort)
    const pbText = pbRaw != null ? formatTimeSmart(pbRaw, false) : "—";
    const avgText = avgRaw != null ? formatTimeSmart(Math.round(avgRaw), true) : "—";

    // final pieces
    const tier = (elo != null) ? mapEloToTierAndDiv(elo) : null;
    const rankText = (tier ? tier : "Unranked") + (globalRank != null ? ` (#${globalRank})` : "");
    const eloText = elo != null ? String(elo) : "—";
    const winsText = wins != null ? String(wins) : "—";
    const losesText = loses != null ? String(loses) : "—";
    const playedText = played != null ? String(played) : "—";

    // Build final string (concise)
    // Example:
    // nickname Elo: 1947 (2163 Peak) • Diamond III (#95) • W/L 97/46 (67.8%) • 145 Played • 07:08 PB (09:41.3 avg) • 0.7% FF Rate • 54 Phase Points • decay in 4d12h
    const parts = [];
    parts.push(`${nick}`);
    const peakPart = peak != null ? ` (${peak} Peak)` : ` (${peakText} Peak)`;
    parts.push(`Elo: ${eloText}${peak != null ? ` (${peak} Peak)` : ""}`);
    parts.push(`${tier ?? "Unranked"}${globalRank != null ? ` (#${globalRank})` : ""}`);
    parts.push(`W/L ${winsText}/${losesText} (${winPercent})`);
    parts.push(`${playedText} Played`);
    parts.push(`${pbText} PB (${avgText} avg)`);
    parts.push(`${ffRateText} FF Rate`);
    parts.push(`${phasePoints} Phase Points`);
    parts.push(`decay in ${decayText}`);

    const out = `${parts.join(" • ")}`;

    // Cache short for chatbots
    res.setHeader("Cache-Control", "s-maxage=8, stale-while-revalidate=30");
    return res.status(200).send(out);
  } catch (err) {
    console.error("[richrank] error:", err);
    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
    return res.status(200).send(`${user} Elo: — | Rank: Unranked`);
  }
};
