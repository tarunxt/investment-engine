from pathlib import Path

path = Path("backend/tests/test_polymarket_auto_live_console_projection.py")
text = path.read_text(encoding="utf-8")
old = "    assert history.stages[0].succeeded_count == 25\n"
new = "    assert history.stages[0].succeeded_count == 44\n"
count = text.count(old)
if count != 1:
    raise RuntimeError(f"projection history count assertion: expected one match, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
