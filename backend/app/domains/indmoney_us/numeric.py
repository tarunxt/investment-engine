"""Exact bounded manual-import arithmetic and explicit Float/JSON boundaries.

Existing snapshot columns remain Float for compatibility. A cash amount is stored
only if its decimal representation survives that boundary; never lose a cent in
an aggregate. Derived percentages alone use declared eight-place half-even
rounding. Precision400 covers all bounded finite float exponents and500 rows.
"""
import math
from decimal import Decimal,InvalidOperation,localcontext,ROUND_HALF_EVEN

MAX_VALUE=Decimal('1000000000000000')
ARITHMETIC_PRECISION=400
PERCENT_QUANTUM=Decimal('0.00000001')


def decimal_value(value):
    if isinstance(value,bool) or not isinstance(value,(int,float,Decimal)):
        raise ValueError('A finite numeric value is required')
    result=Decimal(str(value))
    if not result.is_finite():raise ValueError('A finite numeric value is required')
    return result


def storage_number(value):
    value=decimal_value(value)
    if abs(value)>MAX_VALUE:raise ValueError('Number outside supported storage range')
    result=float(value)
    if not math.isfinite(result) or Decimal(str(result))!=value:
        raise ValueError('Number cannot be stored faithfully; no silent rounding performed')
    return result


def decimal_sum(values):
    if not values or any(value is None for value in values):return None
    with localcontext() as context:
        context.prec=ARITHMETIC_PRECISION
        return sum((decimal_value(value) for value in values),Decimal(0))


def stored_sum(values):
    result=decimal_sum(values)
    return storage_number(result) if result is not None else None


def stored_difference(left,right):
    if left is None or right is None:return None
    with localcontext() as context:
        context.prec=ARITHMETIC_PRECISION
        return storage_number(decimal_value(left)-decimal_value(right))


def derived_percent(pnl,basis):
    if pnl is None or basis in (None,0):return None
    with localcontext() as context:
        context.prec=ARITHMETIC_PRECISION
        value=(decimal_value(pnl)/decimal_value(basis)*100).quantize(PERCENT_QUANTUM,rounding=ROUND_HALF_EVEN)
        return storage_number(value)


def safe_numbers(value,errors,path='parsed'):
    """Keep invalid source text/hashes, replace unusable numeric fields with null.

    Callers must quarantine on these errors. This is not a numeric repair or an
    acceptance waiver; only a JSON-safe representation of a rejected import.
    """
    if isinstance(value,float) and not math.isfinite(value):
        errors.append(f'Nonfinite numeric field at {path}; corrected source required.')
        return None
    if isinstance(value,dict):return {key:safe_numbers(item,errors,path+'.'+str(key)) for key,item in value.items()}
    if isinstance(value,list):return [safe_numbers(item,errors,path+'.'+str(index)) for index,item in enumerate(value)]
    return value


def stored_product(left,right):
    with localcontext() as context:
        context.prec=ARITHMETIC_PRECISION
        return storage_number(decimal_value(left)*decimal_value(right))


def stored_quotient(left,right):
    with localcontext() as context:
        context.prec=ARITHMETIC_PRECISION
        numerator,denominator=decimal_value(left),decimal_value(right)
        result=numerator/denominator
        if result*denominator!=numerator:
            raise ValueError('Nonterminating quotient cannot be stored faithfully')
        return storage_number(result)
