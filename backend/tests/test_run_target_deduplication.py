from app.domains.runs.schemas import RunCreate, RunModelTarget


def test_run_create_deduplicates_targets_preserving_first_selection_order():
    run = RunCreate(
        prompt="Swing Scan",
        targets=[
            RunModelTarget(provider="openai", model="gpt-4o-mini"),
            RunModelTarget(provider="deepseek", model="deepseek-chat"),
            RunModelTarget(provider="openai", model="gpt-4o-mini"),
            RunModelTarget(provider="OpenAI", model="GPT-4O-MINI"),
            RunModelTarget(provider="deepseek", model="deepseek-coder"),
        ],
    )

    assert [(target.provider, target.model) for target in run.targets] == [
        ("openai", "gpt-4o-mini"),
        ("deepseek", "deepseek-chat"),
        ("deepseek", "deepseek-coder"),
    ]
