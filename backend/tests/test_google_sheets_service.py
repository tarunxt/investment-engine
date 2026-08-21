import os
import unittest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.google_sheets.service import GoogleSheetsService


class GoogleSheetsServiceTests(unittest.TestCase):
    def test_extract_spreadsheet_id_accepts_full_google_sheet_url(self):
        spreadsheet_id = GoogleSheetsService.extract_spreadsheet_id(
            "https://docs.google.com/spreadsheets/d/1abcDEF_234xyz/edit?gid=0#gid=0"
        )

        self.assertEqual(spreadsheet_id, "1abcDEF_234xyz")

    def test_build_spreadsheet_url_supports_generic_and_tab_specific_links(self):
        generic_url = GoogleSheetsService.build_spreadsheet_url("1abcDEF_234xyz")
        tab_url = GoogleSheetsService.build_spreadsheet_url("1abcDEF_234xyz", 987654321)

        self.assertEqual(
            generic_url,
            "https://docs.google.com/spreadsheets/d/1abcDEF_234xyz/edit",
        )
        self.assertEqual(
            tab_url,
            "https://docs.google.com/spreadsheets/d/1abcDEF_234xyz/edit#gid=987654321",
        )


if __name__ == "__main__":
    unittest.main()
