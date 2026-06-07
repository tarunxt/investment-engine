"""add prompt source prompt id

Revision ID: 5b7c9d1e2f30
Revises: 4f2a9c8e7b11
Create Date: 2026-06-07 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "5b7c9d1e2f30"
down_revision: Union[str, Sequence[str], None] = "4f2a9c8e7b11"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("prompts")}
    indexes = {index["name"] for index in inspector.get_indexes("prompts")}

    if "source_prompt_id" not in columns:
        op.add_column(
            "prompts",
            sa.Column(
                "source_prompt_id",
                sa.Integer(),
                sa.ForeignKey("prompts.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )
    if op.f("ix_prompts_source_prompt_id") not in indexes:
        op.create_index(
            op.f("ix_prompts_source_prompt_id"),
            "prompts",
            ["source_prompt_id"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("prompts")}
    indexes = {index["name"] for index in inspector.get_indexes("prompts")}

    if op.f("ix_prompts_source_prompt_id") in indexes:
        op.drop_index(op.f("ix_prompts_source_prompt_id"), table_name="prompts")
    if "source_prompt_id" in columns:
        op.drop_column("prompts", "source_prompt_id")
