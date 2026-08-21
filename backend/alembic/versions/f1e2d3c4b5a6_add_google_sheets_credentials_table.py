"""Add google_sheets_credentials table

Revision ID: f1e2d3c4b5a6
Revises: 602557c3ae1b
Create Date: 2026-05-21 10:00:00.000000

"""

import sqlalchemy as sa
from alembic import op

revision = "f1e2d3c4b5a6"
down_revision = "602557c3ae1b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "google_sheets_credentials",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("access_token_enc", sa.Text(), nullable=False),
        sa.Column("refresh_token_enc", sa.Text(), nullable=True),
        sa.Column("token_expiry", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )
    op.create_index(
        "ix_google_sheets_credentials_user_id",
        "google_sheets_credentials",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_google_sheets_credentials_user_id",
        table_name="google_sheets_credentials",
    )
    op.drop_table("google_sheets_credentials")
