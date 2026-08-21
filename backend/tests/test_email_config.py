from app.core.config import Settings


def _settings() -> Settings:
    return Settings(
        database_url="postgresql://test",
        redis_url="redis://test",
    )


def test_legacy_email_sender_environment_names_remain_supported(
    monkeypatch,
) -> None:
    monkeypatch.delenv("SMTP_FROM_EMAIL", raising=False)
    monkeypatch.delenv("SMTP_FROM_NAME", raising=False)
    monkeypatch.setenv("EMAILS_FROM_EMAIL", "legacy@cred-x.in")
    monkeypatch.setenv("EMAILS_FROM_NAME", "Legacy Cred-X")

    settings = _settings()

    assert settings.smtp_from_email == "legacy@cred-x.in"
    assert settings.smtp_from_name == "Legacy Cred-X"


def test_canonical_smtp_sender_environment_names_take_precedence(
    monkeypatch,
) -> None:
    monkeypatch.setenv("SMTP_FROM_EMAIL", "mail@cred-x.in")
    monkeypatch.setenv("SMTP_FROM_NAME", "Cred-X")
    monkeypatch.setenv("EMAILS_FROM_EMAIL", "legacy@cred-x.in")
    monkeypatch.setenv("EMAILS_FROM_NAME", "Legacy Cred-X")

    settings = _settings()

    assert settings.smtp_from_email == "mail@cred-x.in"
    assert settings.smtp_from_name == "Cred-X"
