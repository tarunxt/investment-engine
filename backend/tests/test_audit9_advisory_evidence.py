"""Offline checks of selected advisory ranges against the exact source SBOM."""
import json
from pathlib import Path
from packaging.specifiers import SpecifierSet
from packaging.version import Version

ROOT = Path(__file__).resolve().parents[2]


def test_selected_advisories_use_exact_inventory_versions_and_explicit_limits():
    inventory = json.loads((ROOT / 'docs/privacy-evidence/baseline-source.cdx.json').read_text())
    review = json.loads((ROOT / 'docs/privacy-evidence/advisory-review-20261101.json').read_text())
    assert review['source_revision'] == inventory['metadata']['component']['version']
    assert 'not exhaustive' in review['scope'] and 'unknown' in review['scope']
    assert len(review['advisories']) == 11
    for row in review['advisories']:
        versions = {c['version'] for c in inventory['components']
                    if c['name'].lower() == row['package']
                    and c['purl'].startswith(f"pkg:{row['ecosystem']}/")}
        assert versions == {row['locked_version']}
        assert (Version(row['locked_version']) in SpecifierSet(row['affected_specifier'])) is row['version_matches']
        assert row['source_url'].startswith('https://github.com/advisories/GHSA-')
        assert row['reachability']
