"""Closed public-market projection, independent of prompts, holdings and retrieval.

Only application-owned constants become outbound text. Never infer public status
from a string's appearance or extract identifiers from private portfolio context.
"""
import json

PUBLIC_MARKETS = {'india': 'NIFTY 50', 'us': 'S&P 500', 'global': 'global markets'}
PUBLIC_TOPICS = {'prices': 'live price today', 'news': 'market news today',
                 'earnings': 'earnings announcements', 'macro': 'economic data today'}
PUBLIC_QUERIES = frozenset(f'{market} {topic}' for market in PUBLIC_MARKETS.values()
                           for topic in PUBLIC_TOPICS.values())


def project_query(args: object) -> str | None:
    if not isinstance(args, dict):
        return None
    fields = set(args) - {'max_results'}
    if fields == {'market', 'topic'}:
        market, topic = args['market'], args['topic']
        if type(market) is not str or type(topic) is not str:
            return None
        if market not in PUBLIC_MARKETS or topic not in PUBLIC_TOPICS:
            return None
        return f'{PUBLIC_MARKETS[market]} {PUBLIC_TOPICS[topic]}'
    # Exact legacy compatibility only. Do not strip/rewrite ambiguous private text.
    if fields == {'query'} and type(args['query']) is str and args['query'] in PUBLIC_QUERIES:
        return args['query']
    return None


def admitted_query(payload: str) -> str | None:
    """Metadata comes from the admitted tool response, never model arguments."""
    try:
        result = json.loads(payload)
    except (TypeError, ValueError):
        return None
    if not isinstance(result, dict) or result.get('errors'):
        return None
    query = result.get('query')
    return query if type(query) is str and query in PUBLIC_QUERIES else None
