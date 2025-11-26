// /api/rank.js  (CommonJS - paste into your project)
module.exports = async (req, res) => {
  const user = (req.query.user || "_parad0xx").trim();
  const debug = req.query.debug === "1";

  const fetchJson = async (url) => {
    const r = await fetch(url);
    const text = await r.text();
    try {
      return { ok: r.ok, json: JSON.parse(text), raw: text };
    } catch (e) {
      // Not JSON
      return { ok: r.ok, json: null, raw: text };
    }
  };

  // Helper: recursively search object for first key matching regex
  const findFirstKeyMatch = (obj, re) => {
    if (!obj || typeof obj !== "object") return undefined;
    const stack = [obj];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const k of Object.keys(cur)) {
        if (re.test(k) && (cur[k] !== null && cur[k] !== undefined)) {
          return cur[k];
        }
        const v = cur[k];
        if (typeof v === "object") stack.push(v);
      }
    }
    return undefined;
  };

  try {
    const url = `https://api.mcsrranked.com/users/${encodeURIComponent(user)}`;
    const { ok, json, raw } = await fetchJson(url);

    console.log(`[mcsr-rank] request user=${user} ok=${ok}`);
    if (debug) {
      // Return raw JSON / text so you can inspect exactly what the MCSR API returned
      res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=15");
      return res.status(200).json({ url, ok, raw, parsed: json });
    }

    if (!ok) {
      // If the API returned 404 or other non-ok, treat as not found
      console.warn(`[mcsr-rank] api not ok for user=${user}`);
      return res.status(200).send(`Elo: — | Rank: User not found`);
    }

    // safe-detection for Elo and Rank values in returned JSON
    const eloCandidate =
      (json && (json.eloRate ?? json.elo ?? findFirstKeyMatch(json, /elo/i))) ??
      null;
    const rankCandidate =
      (json && (json.eloRank ?? json.rank ?? findFirstKeyMatch(json, /rank|tier/i))) ??
      null;

    // normalize numeric elo (if it's a string number)
    let elo = null;
    if (eloCandidate !== null && eloCandidate !== undefined) {
      const n = Number(eloCandidate);
      elo = Number.isFinite(n) ? n : eloCandidate; // keep numeric if numeric, else raw
    }

    // map numeric elo -> human tier (adjust thresholds as you like)
    const mapEloToTier = (e) => {
      if (e === null || e === undefined) return null;
      if (typeof e !== "number") return null;
      if (e < 600) return "Coal";
      if (e < 900) return "Iron";
      if (e < 1200) return "Gold";
      if (e < 1400) return "Emerald";
      if (e < 1600) return "Diamond";
      return "Netherite";
    };

    let rankDisplay = null;
    if (rankCandidate) {
      rankDisplay = String(rankCandidate);
    } else if (typeof elo === "number") {
      const tier = mapEloToTier(elo) || "Unranked";
      // simple division calculation (I/II/III) inside each tier - you can tweak
      const tierRanges = {
        Coal: [0, 599],
        Iron: [600, 899],
        Gold: [900, 1199],
        Emerald: [1200, 1399],
        Diamond: [1400, 1599],
        Netherite: [1600, 99999],
      };
      const rrange = tierRanges[tier];
      let div = "";
      if (rrange) {
        const [low, high] = rrange;
        const size = Math.max(1, Math.floor((high - low + 1) / 3));
        const pos = Math.min(2, Math.floor((elo - low) / size)); // 0..2
        div = ["I", "II", "III"][pos] || "";
      }
      rankDisplay = `${tier}${div ? " " + div : ""}`;
    }

    const eloText = elo === null || elo === undefined ? "—" : String(elo);
    const rankText = rankDisplay || "Unranked";

    // cache a little so Cloudbot gets quick responses
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
    return res.status(200).send(`Elo: ${eloText} | Rank: ${rankText}`);
  } catch (err) {
    console.error("[mcsr-rank] unexpected error", err);
    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
    return res.status(500).send("Elo: — | Rank: —");
  }
};
