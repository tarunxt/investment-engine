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

# Polymarket uses competition-specific soccer prefixes.  Keep these mappings
# explicit so a tag can be traced to the exact published standings source.
for code, league, label, minimum in [
    ("bl2", "ger.2", "German 2. Bundesliga", 10),
    ("sea", "ita.1", "Italian Serie A", 10),
    ("uel", "uefa.europa", "UEFA Europa League", 8),
]:
    add(
        f"espn-soccer-{code}", "soccer", f"{label} standings",
        f"https://site.api.espn.com/apis/v2/sports/soccer/{league}/standings",
        "espn-soccer", f"https://www.espn.com/soccer/standings/_/league/{league}", code,
        "Published competition table from ESPN. Rating is a transparent derived points-efficiency percentage (points divided by three times games played); rank and points remain publisher values.",
        minimum=minimum,
    )
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

# Validated published soccer tables; each source retains provider IDs and groups.
for code, league, label, minimum, scope in [
    ("epl", "eng.1", "English Premier League", 20, "domestic"),
    ("elc", "eng.2", "English Championship", 24, "domestic"),
    ("lal", "esp.1", "Spanish LaLiga", 20, "domestic"),
    ("lal2", "esp.2", "Spanish Segunda Division", 22, "domestic"),
    ("bun", "ger.1", "German Bundesliga", 18, "domestic"),
    ("fl1", "fra.1", "French Ligue 1", 18, "domestic"),
    ("tur", "tur.1", "Turkish Super Lig", 18, "domestic"),
    ("ere", "ned.1", "Dutch Eredivisie", 18, "domestic"),
    ("por", "por.1", "Portuguese Primeira Liga", 18, "domestic"),
    ("bel", "bel.1", "Belgian Pro League", 16, "domestic"),
    ("it2", "ita.2", "Italian Serie B", 20, "domestic"),
    ("nwsl", "usa.nwsl", "National Women's Soccer League", 12, "women-senior-club"),
    ("gre1", "gre.1", "Greek Super League", 10, "domestic"),
    ("bol1", "bol.1", "Bolivian Primera Division", 12, "domestic"),
    ("chi1", "chi.1", "Chilean Primera Division", 12, "domestic"),
    ("argpn", "arg.2", "Argentina Primera Nacional", 24, "domestic"),
    ("lib", "conmebol.libertadores", "Copa Libertadores", 24, "continental"),
    ("rus", "rus.1", "Russian Premier League", 12, "domestic"),
    ("enl", "eng.5", "English National League", 20, "domestic"),
    ("uslc", "usa.usl.1", "USL Championship", 20, "domestic"),
    ("acle", "afc.champions", "AFC Champions League Elite", 16, "continental"),
    ("sud", "conmebol.sudamericana", "Copa Sudamericana", 24, "continental"),
    ("aut", "aut.1", "Austrian Bundesliga", 10, "domestic"),
    ("el1", "eng.3", "English League One", 20, "domestic"),
    ("el2", "eng.4", "English League Two", 20, "domestic"),
]:
    add(f"espn-soccer-{code}", "soccer", label,
        f"https://site.api.espn.com/apis/v2/sports/soccer/{league}/standings",
        "espn-soccer", f"https://www.espn.com/soccer/standings/_/league/{league}", code,
        "Published positions and points; rating is points efficiency, not win probability. Groups and seasons are separate; no cross-group rank subtraction.",
        minimum=minimum, provider="espn", priority=10, scope=scope)

# Public server-rendered tables; league ID, country, gender and edition are validated.
for code, league_id, label, country, gender, minimum, scope in [
    ("pol", 196, "Polish Ekstraklasa", "POL", "male", 18, "domestic"),
    ("egy1", 519, "Egyptian Premier League", "EGY", "male", 20, "domestic"),
    ("idn1", 8983, "Indonesian Super League", "IDN", "male", 18, "domestic"),
    ("isr", 127, "Israeli Premier League", "ISR", "male", 14, "domestic"),
    ("rou1", 189, "Romanian Liga I", "ROU", "male", 16, "domestic"),
    ("grc", 145, "Greek Cup league phase", "GRE", "male", 17, "cup"),
    ("u20wwc", 10369, "Women's U20 World Cup", "INT", "female", 24, "women-u20-national"),
]:
    add(f"fotmob-{code}", "soccer", label,
        f"https://www.fotmob.com/leagues/{league_id}/overview", "fotmob", code=code,
        note="Published position and adjusted points in the named edition and group. Points efficiency is not a win probability. Knockout opponents may have different group ranks.",
        league_id=league_id, country=country, gender=gender, minimum=minimum,
        provider="fotmob", priority=10, scope=scope)
