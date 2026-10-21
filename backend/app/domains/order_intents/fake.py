"""No network, SDK, credential, sleep or real provider fallback."""
from .contracts import OrderDenied,digest

class FakeBroker:
    def __init__(self,outcomes=None):self.calls=[];self.outcomes=list(outcomes or []);self.receipts={}
    def submit(self,leg,reference):
        if reference in self.receipts:
            if self.receipts[reference]['payload_digest']!=digest(leg):raise OrderDenied('REFERENCE_CONFLICT')
            return self.receipts[reference]['receipt']
        self.calls.append((reference,dict(leg)))
        outcome=self.outcomes.pop(0) if self.outcomes else 'acknowledged'
        if outcome=='timeout':raise TimeoutError('Synthetic unknown broker outcome')
        if outcome not in {'acknowledged','filled','partial','rejected'}:raise OrderDenied('INVALID_FAKE_RECEIPT')
        result={'state':outcome,'broker_order_id':'fake-'+reference,'filled_quantity':leg['quantity'] if outcome=='filled' else (1 if outcome=='partial' else 0),'client_reference':reference,'payload_digest':digest(leg)}
        self.receipts[reference]={'payload_digest':digest(leg),'receipt':result}
        return result
