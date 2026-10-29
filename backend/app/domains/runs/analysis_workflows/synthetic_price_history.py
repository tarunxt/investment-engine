"""Versioned generated test samples, never acquired market history or AI output.

Only the existing deliberate, credential-free fake source producer uses this.
No read reconstructs samples for an older source. All bytes and deterministic
study values are covered by the immutable source/review digest.
"""
from datetime import datetime,timedelta
from decimal import Decimal,InvalidOperation,localcontext,ROUND_HALF_UP
from uuid import UUID
import re
from .contracts import WorkflowDenied,digest,utc

PROVIDER='offline-fixed-samples-v1'
PATTERN=('0.90','0.92','0.91','0.94','0.93','0.96','0.95','0.98','0.97','1.00','0.99','1.02','1.01','1.03','1.00')

def price(value):
    if type(value) is not str or not re.fullmatch(r'\d{1,8}\.\d{2}',value):raise WorkflowDenied('Exact synthetic cent price required')
    try:
        number=Decimal(value)
        if not number.is_finite() or not Decimal(0)<number<=Decimal('10000000'):raise WorkflowDenied('Bounded positive synthetic price required')
        return number
    except InvalidOperation:raise WorkflowDenied('Synthetic price unavailable') from None

def study(values):
    """Initial Wilder fourteen-change ratio; flat series is explicitly undefined.

These are read-only test-source calculations, never trading/risk eligibility.
No volatility classification, provider recommendation or confidence is inferred.
"""
    if type(values) is not list or len(values)!=15:raise WorkflowDenied('Exactly fifteen synthetic samples required')
    numbers=[price(value) for value in values]
    with localcontext() as ctx:
        ctx.prec=40
        changes=[b-a for a,b in zip(numbers,numbers[1:])]
        gains=sum((max(change,Decimal(0)) for change in changes),Decimal(0))
        losses=sum((max(-change,Decimal(0)) for change in changes),Decimal(0))
        sma5=sum(numbers[-5:],Decimal(0))/5;sma14=sum(numbers[-14:],Decimal(0))/14
        render=lambda value,places:format(value.quantize(Decimal(places),rounding=ROUND_HALF_UP),'f')
        return {'schema_version':1,'algorithm':'rsi14-initial-seed-and-sma-v1','rsi_period':14,
            'rsi_14':None if gains+losses==0 else render(100*gains/(gains+losses),'0.01'),
            'gain_sum':render(gains,'0.01'),'loss_sum':render(losses,'0.01'),
            'sma_5':render(sma5,'0.0001'),'sma_14':render(sma14,'0.0001'),
            'last_close':render(numbers[-1],'0.01'),
            'last_vs_sma_5':'above' if numbers[-1]>sma5 else 'below' if numbers[-1]<sma5 else 'equal',
            'volatility_classification':None,'orders_authorized':False}

def build(source):
    try:
        if (type(source) is not dict or type(source['owner_id']) is not int or source['owner_id']<1
            or source['simulation_only'] is not True or source['portfolio']!='india' or source['currency']!='INR'
            or str(UUID(source['source_receipt_id']))!=source['source_receipt_id']
            or type(source['holdings']) is not list or len(source['holdings'])!=1):raise WorkflowDenied('Owned synthetic source study required')
        holding=source['holdings'][0]
        if holding['exchange']!='NSE' or holding['tradingsymbol']!='SYNTHETIC0':raise WorkflowDenied('Fixed test catalogue only')
        captured=datetime.fromisoformat(source['captured_at'])
        if captured.tzinfo is None:raise WorkflowDenied('Timezone-aware generated source required')
        captured=utc(captured);base=price(holding['last_price'])
        with localcontext() as ctx:
            ctx.prec=40
            samples=[{'sample_at':(captured-timedelta(days=14-index)).isoformat(),
                'close':format((base*Decimal(factor)).quantize(Decimal('0.01'),rounding=ROUND_HALF_UP),'f')}
                for index,factor in enumerate(PATTERN)]
        body={'schema_version':1,'provider':PROVIDER,'owner_id':source['owner_id'],
            'source_receipt_id':source['source_receipt_id'],'generated_at':captured.isoformat(),
            'sample_kind':'generated_test_samples_not_market_observations','instrument':'NSE:SYNTHETIC0',
            'currency':'INR','simulation_only':True,'orders_authorized':False,'samples':samples,
            'study':study([sample['close'] for sample in samples])}
        return {**body,'history_hash':digest(body)}
    except (KeyError,TypeError,ValueError,AttributeError):raise WorkflowDenied('Synthetic study source unavailable') from None

def validate_if_present(source):
    # Backward compatibility: absence is absence, never a generated backfill.
    if type(source) is not dict:raise WorkflowDenied('Synthetic study source shape unavailable')
    if 'price_history' not in source:return False
    if source['price_history']!=build(source):raise WorkflowDenied('Synthetic study integrity or version unavailable')
    return True
