export default async function handler(req, res) {
  const user = req.query.user || "_parad0xx";

  try {
    const api = await fetch(
      `https://api.mcsrranked.com/users/${encodeURIComponent(user)}`
    );
    const json = await api.json();

    const elo = json.eloRate ?? "—";
    const rank = json.eloRank ?? "Unranked";

    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
    return res.status(200).send(`Elo: ${elo} | Rank: ${rank}`);
  } catch (err) {
    return res.status(500).send("Elo: — | Rank: —");
  }
}
