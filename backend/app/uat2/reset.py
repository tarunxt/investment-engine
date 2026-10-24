"""Operator command inside UAT2 container; never creates a login/profile."""
import asyncio
import sys
from sqlalchemy import select
from app.core.uat2 import OWNER_EMAIL, uat2_mode, validate_uat2_startup
from app.domains.auth.models import User
from app.infrastructure.database.session import AsyncSessionLocal
from app.uat2.fixtures import seed_portfolio


async def main():
    if not uat2_mode():
        raise RuntimeError('Reset is UAT2-only')
    validate_uat2_startup()
    async with AsyncSessionLocal() as db:
        user = (await db.execute(select(User).where(User.email == OWNER_EMAIL))).scalar_one_or_none()
        if user is None:
            raise RuntimeError('Owner must sign in with verified Google first')
        await seed_portfolio(db, user.id, reset=True, state=sys.argv[1])
        await db.commit()


if __name__ == '__main__':
    asyncio.run(main())
