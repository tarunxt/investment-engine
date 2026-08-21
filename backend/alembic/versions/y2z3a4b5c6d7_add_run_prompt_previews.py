"""add persisted run prompt previews

Revision ID: y2z3a4b5c6d7
Revises: x1y2z3a4b5c6
"""

from alembic import op
import sqlalchemy as sa


revision = "y2z3a4b5c6d7"
down_revision = "x1y2z3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "runs",
        sa.Column("prompt_preview", sa.String(length=284), nullable=True),
    )
    op.execute(
        """
        UPDATE runs
        SET prompt_preview = CASE
          WHEN length(btrim(regexp_replace(prompt, '\\s+', ' ', 'g'))) <= 280
            THEN btrim(regexp_replace(prompt, '\\s+', ' ', 'g'))
          ELSE rtrim(left(btrim(regexp_replace(prompt, '\\s+', ' ', 'g')), 280)) || '...'
        END
        WHERE prompt_preview IS NULL
        """
    )
    op.alter_column("runs", "prompt_preview", nullable=False)


def downgrade() -> None:
    op.drop_column("runs", "prompt_preview")
