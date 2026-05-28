import re
from datetime import datetime, timedelta, timezone
from typing import Any

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from app.core.config import settings

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


class GoogleSheetsService:
    @property
    def is_configured(self) -> bool:
        return bool(settings.google_client_id and settings.google_client_secret)

    def get_auth_url(self) -> str:
        if not self.is_configured:
            raise ValueError("Google Sheets is not configured")

        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": settings.google_client_id,
                    "client_secret": settings.google_client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": [settings.google_redirect_uri],
                }
            },
            scopes=SCOPES,
        )
        flow.redirect_uri = settings.google_redirect_uri
        auth_url, _ = flow.authorization_url(access_type="offline", prompt="consent")
        return auth_url

    def exchange_code(self, code: str) -> dict[str, Any]:
        if not self.is_configured:
            raise ValueError("Google Sheets is not configured")

        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": settings.google_client_id,
                    "client_secret": settings.google_client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": [settings.google_redirect_uri],
                }
            },
            scopes=SCOPES,
        )
        flow.redirect_uri = settings.google_redirect_uri
        flow.fetch_token(code=code)
        creds = flow.credentials
        expiry = creds.expiry or datetime.now(tz=timezone.utc) + timedelta(hours=1)

        return {
            "access_token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_expiry": expiry,
        }

    def _build_service(self, access_token: str, refresh_token: str | None):
        creds = Credentials(
            token=access_token,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            scopes=SCOPES,
        )
        return build("sheets", "v4", credentials=creds)

    @staticmethod
    def extract_spreadsheet_id(url_or_id: str) -> str:
        """Extract spreadsheet ID from Google Sheets URL or return as-is if already an ID."""
        match = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", url_or_id)
        if match:
            return match.group(1)
        return url_or_id.strip()

    def read_sheet(
        self,
        access_token: str,
        refresh_token: str | None,
        spreadsheet_id: str,
        sheet_name: str = "Sheet1",
    ) -> list[dict[str, Any]]:
        """Read rows from a Google Sheet and return as list of dicts."""
        service = self._build_service(access_token, refresh_token)
        result = (
            service.spreadsheets()
            .values()
            .get(
                spreadsheetId=spreadsheet_id,
                range=sheet_name,
            )
            .execute()
        )
        rows = result.get("values", [])
        if len(rows) < 2:
            return []

        headers = [h.strip().lower() for h in rows[0]]
        records = []

        for row in rows[1:]:
            padded = row + [""] * (len(headers) - len(row))
            record: dict[str, Any] = {}
            for i, header in enumerate(headers):
                if padded[i].strip():
                    record[header] = padded[i].strip()
            if record:
                records.append(record)

        return records

    def write_sheet(
        self,
        access_token: str,
        refresh_token: str | None,
        spreadsheet_id: str,
        headers: list[str],
        rows: list[list[str]],
        sheet_name: str = "Sheet1",
    ) -> tuple[int, int]:
        """Write data to a Google Sheet."""
        service = self._build_service(access_token, refresh_token)
        sheet_id = self.ensure_sheet(service, spreadsheet_id, sheet_name)
        values = [headers] + rows

        service.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range=f"{sheet_name}!A1",
            valueInputOption="RAW",
            body={"values": values},
        ).execute()

        return len(rows), sheet_id

    @staticmethod
    def ensure_sheet(service, spreadsheet_id: str, sheet_name: str) -> int:
        metadata = service.spreadsheets().get(
            spreadsheetId=spreadsheet_id,
            fields="sheets(properties(sheetId,title))",
        ).execute()
        for sheet in metadata.get("sheets", []):
            props = sheet.get("properties", {})
            if props.get("title") == sheet_name:
                return int(props["sheetId"])

        created = service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "requests": [
                    {"addSheet": {"properties": {"title": sheet_name}}},
                ]
            },
        ).execute()
        return int(created["replies"][0]["addSheet"]["properties"]["sheetId"])

    def create_spreadsheet(
        self, access_token: str, refresh_token: str | None, title: str
    ) -> str:
        """Create a new Google Spreadsheet."""
        service = self._build_service(access_token, refresh_token)
        spreadsheet = (
            service.spreadsheets()
            .create(
                body={
                    "properties": {"title": title},
                    "sheets": [{"properties": {"title": "Data"}}],
                }
            )
            .execute()
        )
        return spreadsheet["spreadsheetId"]
