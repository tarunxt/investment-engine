"""Validated Screener-style comparisons. Only explicit numeric fields and operators are evaluated."""
import ast
import math
import operator
import re
from functools import lru_cache

FIELDS = {
    "Market Capitalization": "cap", "Return on capital employed": "roce",
    "Debt to equity": "leverage", "Sales growth 3Years": "sales_3y", "Profit growth 3Years": "profit_3y",
    "Cash from operations last year": "operating_cash", "Current price": "price",
    "Low price": "low_52w", "High price": "high_52w", "Return over 1day": "day_return",
    "MACD": "macd", "MACD Previous Day": "previous_macd",
}
OPS = {ast.Add:operator.add, ast.Sub:operator.sub, ast.Mult:operator.mul, ast.Div:operator.truediv,
       ast.Lt:operator.lt, ast.LtE:operator.le, ast.Gt:operator.gt, ast.GtE:operator.ge,
       ast.Eq:operator.eq, ast.NotEq:operator.ne}

@lru_cache(maxsize=64)
def compile_query(text):
    return compile_expression(text, FIELDS)


def compile_expression(text, fields):
    if not text.strip() or len(text)>4000:
        raise ValueError("Enter a query of 1 to 4,000 characters.")
    # Use generated identifiers exclusively. User-entered Python identifiers cannot stand in for ratios.
    if re.search(r"[_#'\"\\;:\[\]{}@]", text):
        raise ValueError("Use ratio names, numbers, parentheses, comparisons, AND or OR.")
    pattern = r"\b(?:" + "|".join(re.escape(k).replace(r"\ ",r"\s+") for k in sorted(fields,key=len,reverse=True)) + r")\b"
    names = {k.casefold(): v for k,v in fields.items()}
    expr = re.sub(pattern, lambda m: "_"+names[" ".join(m[0].casefold().split())], text, flags=re.I)
    expr = re.sub(r"\b(and|or)\b", lambda m:m[0].lower(), expr, flags=re.I)
    expr = re.sub(r"(?<![><=!])=(?!=)", "==", expr)
    try:
        root = ast.parse(" ".join(expr.split()), mode="eval").body
    except (SyntaxError, ValueError, RecursionError):
        raise ValueError("Invalid query. Check each comparison and its parentheses.") from None
    if sum(1 for _ in ast.walk(root))>384:
        raise ValueError("The query contains too many operations.")

    def validate(node, boolean):
        if boolean and isinstance(node, ast.BoolOp) and isinstance(node.op,(ast.And,ast.Or)):
            for child in node.values:
                validate(child, True)
        elif boolean and isinstance(node, ast.Compare) and len(node.ops)==1 and type(node.ops[0]) in OPS:
            validate(node.left, False)
            validate(node.comparators[0], False)
        elif not boolean and isinstance(node, ast.BinOp) and type(node.op) in OPS:
            validate(node.left, False)
            validate(node.right, False)
        elif not boolean and isinstance(node, ast.UnaryOp) and isinstance(node.op,(ast.UAdd,ast.USub)):
            validate(node.operand, False)
        elif not boolean and isinstance(node, ast.Name) and node.id.startswith("_") and node.id[1:] in fields.values():
            pass
        elif not boolean and isinstance(node, ast.Constant) and type(node.value) in (float,int) and abs(node.value)<=1e18:
            pass
        else:
            raise ValueError("Unsupported ratio or expression. Use a listed field in a numeric comparison.")
    validate(root, True)
    return root

def evaluate(node, values):
    """Unknown inputs propagate unless another clause already determines the result."""
    if isinstance(node, ast.BoolOp):
        is_and = isinstance(node.op, ast.And)
        decisive = not is_and
        unknown = False
        for child in node.values:
            result = evaluate(child, values)
            if result is decisive:
                return result
            unknown |= result is None
        return None if unknown else is_and
    if isinstance(node, ast.Name):
        v = values.get(node.id[1:])
        return v if isinstance(v,(int,float)) and math.isfinite(v) else None
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.UnaryOp):
        v = evaluate(node.operand, values)
        return -v if v is not None and isinstance(node.op, ast.USub) else v
    compared = isinstance(node, ast.Compare)
    left = evaluate(node.left, values)
    right = evaluate(node.comparators[0] if compared else node.right, values)
    if left is None or right is None:
        return None
    try:
        result = OPS[type(node.ops[0] if compared else node.op)](left,right)
        return result if math.isfinite(result) else None
    except (ZeroDivisionError, OverflowError):
        return None
