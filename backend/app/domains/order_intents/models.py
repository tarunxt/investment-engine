from uuid import uuid4
from datetime import datetime
from sqlalchemy import String,Integer,JSON,DateTime,ForeignKey,UniqueConstraint,CheckConstraint,ForeignKeyConstraint
from sqlalchemy.orm import Mapped,mapped_column
from app.infrastructure.database.base import Base

STATES=('draft','validated','awaiting_approval','approved','submitting','acknowledged','unknown','partial','filled','rejected','cancelled','invalidated')
class OrderIntent(Base):
    __tablename__='confirmed_order_intents'
    __table_args__=(UniqueConstraint('owner_id','operation_key_digest',name='uq_confirmed_order_operation'),
        ForeignKeyConstraint(['connection_id','owner_id'],['integration_connections.id','integration_connections.owner_id']),
        CheckConstraint('connection_version > 0 AND module_version > 0',name='ck_confirmed_order_versions'),
        CheckConstraint("state IN ("+','.join(repr(s) for s in STATES)+")",name='ck_confirmed_order_state'))
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=lambda:str(uuid4()))
    owner_id:Mapped[int]=mapped_column(ForeignKey('users.id'),nullable=False,index=True)
    operation_key_digest:Mapped[str]=mapped_column(String(64),nullable=False)
    request_digest:Mapped[str]=mapped_column(String(64),nullable=False)
    connection_id:Mapped[str]=mapped_column(String(36),nullable=False)
    connection_version:Mapped[int]=mapped_column(Integer,nullable=False)
    account_id:Mapped[str]=mapped_column(String(64),nullable=False)
    app_mode:Mapped[str]=mapped_column(String(24),nullable=False)
    module_id:Mapped[str]=mapped_column(String(40),nullable=False)
    module_version:Mapped[int]=mapped_column(Integer,nullable=False)
    payload_json:Mapped[dict]=mapped_column(JSON,nullable=False)
    risk_json:Mapped[dict|None]=mapped_column(JSON)
    review_digest:Mapped[str|None]=mapped_column(String(64))
    state:Mapped[str]=mapped_column(String(24),nullable=False,default='draft')
    approval_digest:Mapped[str|None]=mapped_column(String(64))
    approval_nonce:Mapped[str|None]=mapped_column(String(36))
    approved_by:Mapped[int|None]=mapped_column(Integer)
    approved_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    expires_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),nullable=False)

class OrderLeg(Base):
    __tablename__='confirmed_order_legs'
    __table_args__=(UniqueConstraint('intent_id','position',name='uq_confirmed_order_leg'),CheckConstraint('position >= 0 AND filled_quantity >= 0',name='ck_confirmed_order_leg_values'))
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=lambda:str(uuid4()))
    intent_id:Mapped[str]=mapped_column(ForeignKey('confirmed_order_intents.id'),nullable=False,index=True)
    position:Mapped[int]=mapped_column(Integer,nullable=False)
    payload_digest:Mapped[str]=mapped_column(String(64),nullable=False)
    client_reference:Mapped[str]=mapped_column(String(64),unique=True,nullable=False)
    state:Mapped[str]=mapped_column(String(24),nullable=False,default='draft')
    broker_order_id:Mapped[str|None]=mapped_column(String(100))
    filled_quantity:Mapped[int]=mapped_column(Integer,nullable=False,default=0)
    reconciliation_json:Mapped[dict|None]=mapped_column(JSON)
