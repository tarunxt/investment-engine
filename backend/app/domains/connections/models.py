from datetime import datetime
from uuid import uuid4
from sqlalchemy import Boolean,CheckConstraint,DateTime,ForeignKey,ForeignKeyConstraint,Index,Integer,String,Text,UniqueConstraint,text
from sqlalchemy.orm import Mapped,mapped_column
from app.infrastructure.database.base import Base,TimestampMixin

class IntegrationConnection(Base,TimestampMixin):
    __tablename__='integration_connections'
    __table_args__=(UniqueConstraint('id','owner_id',name='uq_connection_id_owner'),
        CheckConstraint("app_ownership_mode IN ('user_owned','platform_managed')",name='ck_connection_mode'),
        CheckConstraint('version > 0',name='ck_connection_version'),
        # Provisional primary-account policy, not a unique owner/provider schema.
        # Historical/candidate rows remain possible; future multi-account routing
        # can replace this index without replacing connection identities.
        Index('uq_connection_current_owner_provider','owner_id','provider',unique=True,
              postgresql_where=text('is_current = true'),sqlite_where=text('is_current = 1')))
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=lambda:str(uuid4()))
    owner_id:Mapped[int]=mapped_column(ForeignKey('users.id',ondelete='CASCADE'),index=True)
    provider:Mapped[str]=mapped_column(String(32),nullable=False,default='zerodha')
    app_ownership_mode:Mapped[str]=mapped_column(String(24),nullable=False)
    provider_account_id:Mapped[str|None]=mapped_column(String(64),nullable=True)
    credential_ref:Mapped[str|None]=mapped_column(String(100),nullable=True)
    token_expires_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)
    status:Mapped[str]=mapped_column(String(32),nullable=False,default='configured')
    version:Mapped[int]=mapped_column(Integer,nullable=False,default=1)
    is_current:Mapped[bool]=mapped_column(Boolean,nullable=False,default=True)

    @property
    def expires_at(self):return self.token_expires_at
    @property
    def login_time(self):return self.created_at

class ConnectionCredential(Base,TimestampMixin):
    __tablename__='connection_credentials'
    __table_args__=(ForeignKeyConstraint(['connection_id','owner_id'],['integration_connections.id','integration_connections.owner_id'],ondelete='CASCADE'),
        UniqueConstraint('connection_id',name='uq_connection_private_material'),
        CheckConstraint('key_version > 0',name='ck_connection_key_version'))
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=lambda:str(uuid4()))
    connection_id:Mapped[str]=mapped_column(String(36),nullable=False)
    owner_id:Mapped[int]=mapped_column(Integer,nullable=False,index=True)
    ciphertext:Mapped[str]=mapped_column(Text,nullable=False)
    key_version:Mapped[int]=mapped_column(Integer,nullable=False)
