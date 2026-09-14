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
