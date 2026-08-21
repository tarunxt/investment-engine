"""add normalized dashboard holding summaries

Revision ID: z3a4b5c6d7e8
Revises: y2z3a4b5c6d7
"""

from alembic import op
import sqlalchemy as sa


revision = "z3a4b5c6d7e8"
down_revision = "y2z3a4b5c6d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "zerodha_portfolio_snapshots",
        sa.Column(
            "holdings_invested_value",
            sa.Float(),
            nullable=True,
        ),
    )
    op.add_column(
        "zerodha_portfolio_snapshots",
        sa.Column(
            "dashboard_top_holdings",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )
    op.add_column(
        "indmoney_us_portfolio_snapshots",
        sa.Column(
            "dashboard_top_holdings",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )

    op.execute(
        """
        UPDATE zerodha_portfolio_snapshots AS snapshot
        SET
          holdings_invested_value = (
            SELECT CASE
              WHEN bool_or(
                item->'invested_value' IS NOT NULL
                AND json_typeof(item->'invested_value') <> 'number'
              )
                THEN NULL
              ELSE sum(
                CASE
                  WHEN json_typeof(item->'invested_value') = 'number'
                    THEN (item->>'invested_value')::double precision
                  ELSE 0
                END
              )
            END
            FROM json_array_elements(snapshot.holdings) AS item
          ),
          dashboard_top_holdings = COALESCE(
            (
              SELECT json_agg(item)
              FROM (
                SELECT item
                FROM json_array_elements(snapshot.holdings) AS item
                ORDER BY
                  CASE
                    WHEN json_typeof(item->'market_value') = 'number'
                      THEN (item->>'market_value')::double precision
                    WHEN json_typeof(item->'current_value') = 'number'
                      THEN (item->>'current_value')::double precision
                    ELSE 0
                  END DESC
                LIMIT 4
              ) AS ranked
            ),
            '[]'::json
          )
        WHERE json_typeof(snapshot.holdings) = 'array'
        """
    )
    op.execute(
        """
        UPDATE indmoney_us_portfolio_snapshots AS snapshot
        SET dashboard_top_holdings = COALESCE(
          (
            SELECT json_agg(item)
            FROM (
              SELECT item
              FROM json_array_elements(snapshot.holdings) AS item
              ORDER BY
                CASE
                  WHEN json_typeof(item->'current_value') = 'number'
                    THEN (item->>'current_value')::double precision
                  WHEN json_typeof(item->'market_value') = 'number'
                    THEN (item->>'market_value')::double precision
                  ELSE 0
                END DESC
              LIMIT 4
            ) AS ranked
          ),
          '[]'::json
        )
        WHERE json_typeof(snapshot.holdings) = 'array'
        """
    )

    op.alter_column(
        "zerodha_portfolio_snapshots",
        "dashboard_top_holdings",
        server_default=None,
    )
    op.alter_column(
        "indmoney_us_portfolio_snapshots",
        "dashboard_top_holdings",
        server_default=None,
    )


def downgrade() -> None:
    op.drop_column(
        "indmoney_us_portfolio_snapshots",
        "dashboard_top_holdings",
    )
    op.drop_column(
        "zerodha_portfolio_snapshots",
        "dashboard_top_holdings",
    )
    op.drop_column(
        "zerodha_portfolio_snapshots",
        "holdings_invested_value",
    )
