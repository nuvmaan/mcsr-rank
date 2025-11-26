// /api/rank.js  (CommonJS - Vercel friendly)
module.exports = async (req, res) => {
  const user = (req.query.user || "_parad0xx").trim();
  const debug = req.query.debug === "1";

  const fetchJson = async (url) => {
    const r = await fetch(url);
    const text = await r.text();
    try {
      return { ok: r.ok, json: JSON.parse(text), raw: text };
    } catch (e) {
      return { ok: r.ok, json: null, raw: text };
    }
  };

  try {
    const url = `https://api.mcsrranked.com/users/${encodeURIComponent(user)}`;
    const { ok, json, raw } = await fetchJson(url);

    if (debug) {
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=15");
      return res.status(200).json({ url, ok, raw, parsed: json });
    }

    if (!ok || !json) {
      return res.status(200).send(`Elo: — | Rank: User not found`);
    }

    // Prefer eloRate (numeric Elo). Fallback attempts for other field names.
    const eloRaw = json.eloRate ?? json.elo ?? (function findFirst(o, re){
      if (!o || typeof o !== 'object') return undefined;
      const stack=[o], seen=new Set();
      while(stack.length){
        const cur = stack.pop();
        if(seen.has(cur)) continue;
        seen.add(cur);
        for(const k of Object.keys(cur)){
          const v = cur[k];
          if(re.test(k) && v != null) return v;
          if(typeof v === 'object') stack.push(v);
        }
      }
      return undefined;
    })(json, /elo/i);

    // Parse numeric Elo if possible
    const elo = (eloRaw === null || eloRaw === undefined) ? null : (Number(eloRaw) || (Number.isFinite(Number(eloRaw)) ? Number(eloRaw) : eloRaw));
    // Note: json.eloRank is often a global rank (7187) — detect that:
    const rawRank = json.eloRank ?? json.rank ?? null;

    // Elo -> Tier thresholds (adjust if you want different cutoffs)
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
      // compute division I/II/III by splitting tier range into 3 equal parts
      const low = Math.max(tier.min, 0);
      const high = tier.max === Infinity ? (low + 600) : tier.max; // for Netherite just assume large
      const size = Math.max(1, Math.floor((high - low + 1) / 3));
      const pos = Math.max(0, Math.min(2, Math.floor((e - low) / size)));
      const div = ["I", "II", "III"][pos] || "";
      return `${tier.name}${div ? " " + div : ""}`;
    };

    // If rawRank seems like a global leaderboard number (>=100 or large), don't show it as tier.
    let rankText = null;
    if (rawRank && typeof rawRank === "string" && rawRank.match(/[A-Za-z]/)) {
      // if API returned textual rank (like "Iron II"), trust it
      rankText = rawRank;
    } else if (rawRank && typeof rawRank === "number" && rawRank <= 50 && !elo) {
      // if it's a small number and no elo present, it might be a division id; show it anyway
      rankText = String(rawRank);
    } else if (typeof rawRank === "number" && rawRank > 50) {
      // Likely global position → ignore for readable tier
      rankText = null;
    }

    // Prefer computed tier from Elo
    const computedTier = mapEloToTierAndDiv(typeof elo === "number" ? elo : null);
    if (computedTier) rankText = computedTier;

    const eloText = (elo === null || elo === undefined) ? "—" : String(elo);
    if (!rankText) rankText = "Unranked";

    // Cache a little for Cloudbot speed
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
    return res.status(200).send(`Elo: ${eloText} | Rank: ${rankText}`);
  } catch (err) {
    console.error("[mcsr-rank] error:", err);
    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
    return res.status(500).send("Elo: — | Rank: —");
  }
};
