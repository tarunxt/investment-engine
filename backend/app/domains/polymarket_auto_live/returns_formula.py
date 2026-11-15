from __future__ import annotations

import ast
import math


DEFAULT_RETURNS_PER_DAY_FORMULA = (
    "=(100-CURRENT_CHOSEN_SIDE_BULLPEN_ODDS)/(DAYS_UNTIL_CLOSE+4)"
)
RETURNS_PER_DAY_FORMULA_VARIABLES = frozenset(
    {"CURRENT_CHOSEN_SIDE_BULLPEN_ODDS", "DAYS_UNTIL_CLOSE"}
)


class ReturnsPerDayFormulaError(ValueError):
    pass


def _evaluate(node: ast.AST, variables: dict[str, float]) -> float:
    if isinstance(node, ast.Expression):
        return _evaluate(node.body, variables)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.Name) and node.id in variables:
        return variables[node.id]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _evaluate(node.operand, variables)
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.BinOp) and isinstance(
        node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)
    ):
        left = _evaluate(node.left, variables)
        right = _evaluate(node.right, variables)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            if right == 0:
                raise ReturnsPerDayFormulaError("Formula cannot divide by zero")
            return left / right
        return left**right
    raise ReturnsPerDayFormulaError(
        "Use only numbers, +, -, *, /, ^, parentheses, and the supported fields"
    )


def validate_returns_per_day_formula(formula: str) -> str:
    normalized = formula.strip().upper()
    if not normalized.startswith("="):
        raise ReturnsPerDayFormulaError("Formula must start with =")
    expression = normalized[1:].replace("^", "**")
    if len(expression) > 300:
        raise ReturnsPerDayFormulaError("Formula must be 300 characters or fewer")
    try:
        parsed = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise ReturnsPerDayFormulaError("Formula syntax is invalid") from exc
    names = {node.id for node in ast.walk(parsed) if isinstance(node, ast.Name)}
    unsupported = sorted(names - RETURNS_PER_DAY_FORMULA_VARIABLES)
    if unsupported:
        raise ReturnsPerDayFormulaError(
            f"Unsupported field: {unsupported[0]}"
        )
    _evaluate(
        parsed,
        {
            "CURRENT_CHOSEN_SIDE_BULLPEN_ODDS": 50.0,
            "DAYS_UNTIL_CLOSE": 10.0,
        },
    )
    return normalized


def calculate_returns_per_day_formula(
    *,
    current_chosen_side_bullpen_odds: float,
    days_until_close: float,
    formula: str = DEFAULT_RETURNS_PER_DAY_FORMULA,
) -> float | None:
    try:
        normalized = validate_returns_per_day_formula(formula)
        parsed = ast.parse(normalized[1:].replace("^", "**"), mode="eval")
        result = _evaluate(
            parsed,
            {
                "CURRENT_CHOSEN_SIDE_BULLPEN_ODDS": float(
                    current_chosen_side_bullpen_odds
                ),
                "DAYS_UNTIL_CLOSE": float(days_until_close),
            },
        )
    except (OverflowError, ReturnsPerDayFormulaError, ValueError, ZeroDivisionError):
        return None
    if not math.isfinite(result):
        return None
    return round(result, 2)
