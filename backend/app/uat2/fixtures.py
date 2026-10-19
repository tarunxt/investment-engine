"""Synthetic rows using existing application models, after verified owner login."""
import os
from datetime import datetime, timezone
from sqlalchemy import select, delete
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.uat2.adapters import STAMP


async def seed_portfolio(db, user_id, *, reset=False, state=None):
    state = state or os.getenv('UAT2_FIXTURE_STATE', 'populated')
    if state not in {'empty', 'populated'}:
        raise ValueError('Fixture state must be empty or populated')
    query = select(IndMoneyUsPortfolioSnapshot).where(
        IndMoneyUsPortfolioSnapshot.user_id == user_id,
        IndMoneyUsPortfolioSnapshot.source == 'uat2_synthetic')
    existing = (await db.execute(query)).scalars().all()
    if existing and not reset:
        return
    if reset:
        await db.execute(delete(IndMoneyUsPortfolioSnapshot).where(
            IndMoneyUsPortfolioSnapshot.user_id == user_id,
            IndMoneyUsPortfolioSnapshot.source == 'uat2_synthetic'))
    if state == 'empty':
        return
    captured = datetime.fromisoformat(STAMP)
    db.add(IndMoneyUsPortfolioSnapshot(
        user_id=user_id, snapshot_date=captured.date(), captured_at=captured,
        source='uat2_synthetic', raw_text='UAT2 synthetic fixture v1',
        parse_status='parsed', parse_warnings=['Synthetic data; no real investments'],
        holdings_count=2, current_value=1050, invested_value=1000,
        wallet_balance=100, total_return_value=50, total_return_percent=5,
        day_return_value=5, day_return_percent=0.48,
        holdings=[{'symbol': 'UATA', 'company_name': 'Synthetic Alpha', 'quantity': 5,
                   'average_price': 100, 'market_price': 110, 'current_value': 550,
                   'invested_value': 500, 'total_pnl': 50, 'total_pnl_percent': 10},
                  {'symbol': 'UATB', 'company_name': 'Synthetic Beta', 'quantity': 10,
                   'average_price': 50, 'market_price': 50, 'current_value': 500,
                   'invested_value': 500, 'total_pnl': 0, 'total_pnl_percent': 0}],
        dashboard_top_holdings=[{'symbol': 'UATA', 'company_name': 'Synthetic Alpha',
                                'current_value': 550, 'invested_value': 500, 'pnl': 50}],
    ))
