"""API usage routes with corrected LLM usage reconciliation.

The corrected routes are inserted before the legacy routes so existing endpoint
URLs remain backward compatible while using the more complete aggregation.
"""

from app.domains.api_usage.router import router
from app.domains.api_usage.corrected_router import router as corrected_router

router.routes[:0] = corrected_router.routes

__all__ = ["router"]
