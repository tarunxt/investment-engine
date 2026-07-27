from app.shared.pagination import PagedResult


def test_paged_result_exposes_frontend_size_alias_without_dropping_limit():
    result = PagedResult(items=[{"id": 1}], total=101, page=1, limit=100)

    payload = result.to_dict()

    assert payload == {
        "items": [{"id": 1}],
        "total": 101,
        "page": 1,
        "limit": 100,
        "size": 100,
        "pages": 2,
    }


def test_empty_paged_result_retains_one_page_contract():
    payload = PagedResult(items=[], total=0, page=1, limit=100).to_dict()

    assert payload["size"] == 100
    assert payload["limit"] == 100
    assert payload["pages"] == 1
