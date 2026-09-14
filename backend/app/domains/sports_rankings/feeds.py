"""Explicit, public ranking feeds. Internal source IDs are not market codes."""
FEEDS = {}


def add(key, sport, name, url, parser, reference=None, code=None, note="", **options):
    FEEDS[key] = dict(sport_id=sport, name=name, url=url, parser=parser,
                      reference_url=reference or url, code=code, note=note, **options)


for league, sport, path in [
    ("nba", "basketball", "basketball"), ("wnba", "basketball", "basketball"),
    ("nfl", "american-football", "football"), ("mlb", "baseball", "baseball"),
]:
    add(f"espn-{league}", sport, f"{league.upper()} season standings", f"https://site.api.espn.com/apis/v2/sports/{path}/{league}/standings", "espn", f"https://www.espn.com/{league}/standings", league,
        "ESPN records, ordered within each published group by win percentage (derived; equal records share a rank). Not an official playoff seed or cross-group ranking. If the new season has no games, the previous season is explicitly labelled.")
add("nhl-official", "ice-hockey", "NHL league standings", "https://api-web.nhle.com/v1/standings/now", "nhl", "https://www.nhl.com/standings", "nhl",
    "Official NHL league order. The source may return the last completed season before the new season starts; season and source date are shown.")
for gender, key in [("Men", "mru"), ("Women", "wru")]:
    add(f"rugby-{key}", "rugby-union", f"World Rugby — {gender}", f"https://api.wr-rims-prod.pulselive.com/rugby/v3/rankings/{key}", "rugby", "https://www.world.rugby/rankings", note="National rugby union teams only. Not rugby league, sevens or club rankings.")
for tour in ["atp", "wta"]:
    add(f"espn-{tour}", "tennis-singles", f"{tour.upper()} singles — ESPN published list", f"https://site.api.espn.com/apis/site/v2/sports/tennis/{tour}/rankings", "tennis", f"https://www.espn.com/tennis/rankings/_/type/{tour}", tour,
        "Published singles list carried by ESPN (currently 150 players), not all tour players. Senior singles only; do not substitute it for doubles or juniors.")
add("wta-doubles", "tennis-doubles", "WTA individual doubles ranking — published page", "https://www.wtatennis.com/rankings/doubles", "wta", note="Individual doubles-player rankings shown by WTA. Not a ranking of the combined pair; the page's published subset is displayed.")
add("ufc-divisions", "mma", "UFC rankings by division", "https://www.ufc.com/rankings", "ufc", code="ufc", note="UFC only. Each weight class and pound-for-pound list is separate. Champions are labelled, not assigned rank zero. A fighter may appear in more than one list.")
for kind, label in [("open", "Standard open"), ("women", "Standard women"), ("men_rapid", "Rapid open"), ("women_rapid", "Rapid women"), ("men_blitz", "Blitz open"), ("women_blitz", "Blitz women")]:
    add(f"fide-{kind}", "chess", f"FIDE {label} — top 100", f"https://ratings.fide.com/a_top.php?list={kind}", "fide", f"https://ratings.fide.com/top_lists.phtml?list={kind}", "chess", "Published top 100 only. Standard, rapid and blitz are distinct rating systems; this is not the entire FIDE player database.")
add("netball-world", "netball", "World Netball national-team rankings", "https://netball.sport/events-and-results/world-rankings-hub/current-world-rankings/", "netball", note="World Netball's published national-team ranking. Rating and weighted ranking points are distinct values.")
for discipline in ["outdoor", "indoor"]:
    add(f"fih-{discipline}", f"{'field' if discipline == 'outdoor' else 'indoor'}-hockey", f"FIH {discipline} rankings — published men's list", f"https://www.fih.hockey/{discipline}-hockey-rankings", "fih", note="The public page currently supplies the men's list. Women's rankings are not inferred from men's positions. Individual last-match dates are not ranking publication dates.")

# Cricket has public web tables even when ICC's site rejects server requests.
for gender, formats in [("men", ("test", "odi", "t20")), ("women", ("odi", "t20"))]:
    for fmt in formats:
        add(f"cricket-{gender}-{fmt}", f"{fmt}-cricket", f"ICC {gender}'s {fmt.upper()} team rankings — Cricbuzz",
            f"https://www.cricbuzz.com/cricket-stats/icc-rankings/{gender}/teams", "cricket-rankings",
            f"https://www.icc-cricket.com/rankings/team-rankings/{gender}s/{'t20i' if fmt == 't20' else fmt}",
            note="ICC national-team rankings as published by Cricbuzz. Format and gender are separate. Rating, points and matches are publisher values. Cricbuzz does not supply a publication date for this table; retrieval time is shown separately.",
            gender=gender, format=fmt, minimum=10)
for gender in ["men", "women"]:
    add(f"cricket-hundred-{gender}", "the-hundred", f"The Hundred — {gender}'s standings", "https://www.thehundred.com/standings", "cricket-hundred",
        note="Official season league table, separately for men and women. Published position is not the final playoff result. NRR means net run rate, not a team rating.", gender=gender, minimum=8)
for competition, label in [("county-championship", "County Championship — first-class divisions"), ("one-day-cup", "One Day Cup — List A groups")]:
    add(f"cricket-{competition}", "domestic-cricket", label, f"https://www.ecb.co.uk/matches/{competition}/tables", "cricket-ecb",
        note="Official ECB men's competition standings. Groups/divisions and season remain separate. Published points include the publisher's adjustments; no recalculation from match wins.", minimum=18)
for key, sport, series, slug, name, minimum in [
    ("t10", "t10-cricket", 11119, "abu-dhabi-t10-league-2025", "Abu Dhabi T10 League 2025", 8),
    ("ipl", "t20-cricket", 9241, "indian-premier-league-2026", "Indian Premier League 2026", 10),
    ("cpl", "t20-cricket", 12123, "caribbean-premier-league-2026", "Caribbean Premier League 2026", 7),
]:
    add(f"cricket-{key}", sport, name, f"https://www.cricbuzz.com/cricket-series/{series}/{slug}/points-table", "cricket-table",
        note="Cricbuzz published league-stage order for this named edition, not a world ranking or playoff finish. Completed editions remain labelled by year; they are not automatically substituted for a new season. NRR is net run rate.",
        series_id=series, series_name=name, minimum=minimum)

CRICKET_SOURCE_IDS = {key for key in FEEDS if key.startswith("cricket-")}
