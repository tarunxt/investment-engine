from dataclasses import dataclass
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from app.core.config import settings
from app.core.logging import get_logger
from app.domains.google_sheets.crypto import decrypt_token
from app.domains.google_sheets.repository import GoogleSheetsAppConfigSyncRepository
from app.infrastructure.database.sync_session import SyncSessionLocal

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
logger = get_logger(__name__)


@dataclass(frozen=True)
class GoogleSheetsOAuthConfig:
    client_id: str | None
    client_secret: str | None
    redirect_uri: str


class GoogleSheetsService:
    def _get_oauth_config(self) -> GoogleSheetsOAuthConfig:
        stored_client_id: str | None = None
        stored_client_secret: str | None = None

        try:
            with SyncSessionLocal() as db:
                config = GoogleSheetsAppConfigSyncRepository(db).get()
                if config:
                    stored_client_id = config.client_id.strip() or None
                    stored_client_secret = decrypt_token(config.client_secret_enc)
        except Exception:
            logger.exception("Failed to load stored Google Sheets app config")

        return GoogleSheetsOAuthConfig(
            client_id=stored_client_id or settings.google_client_id,
            client_secret=stored_client_secret or settings.google_client_secret,
            redirect_uri=settings.google_redirect_uri,
        )

    @property
    def is_configured(self) -> bool:
        config = self._get_oauth_config()
        return bool(config.client_id and config.client_secret)

    def _client_config(self, config: GoogleSheetsOAuthConfig) -> dict[str, Any]:
        if not (config.client_id and config.client_secret):
            raise ValueError("Google Sheets is not configured")

        return {
            "web": {
                "client_id": config.client_id,
                "client_secret": config.client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [config.redirect_uri],
            }
        }

    def get_auth_url(self) -> str:
        config = self._get_oauth_config()
        flow = Flow.from_client_config(
            self._client_config(config),
            scopes=SCOPES,
        )
        flow.redirect_uri = config.redirect_uri
        auth_url, _ = flow.authorization_url(access_type="offline", prompt="consent")
        return auth_url

    def exchange_code(self, code: str) -> dict[str, Any]:
        config = self._get_oauth_config()
        flow = Flow.from_client_config(
            self._client_config(config),
            scopes=SCOPES,
        )
        flow.redirect_uri = config.redirect_uri
        flow.fetch_token(code=code)
        creds = flow.credentials
        expiry = creds.expiry or datetime.now(tz=timezone.utc) + timedelta(hours=1)

        return {
            "access_token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_expiry": expiry,
        }

    def _build_service(self, access_token: str, refresh_token: str | None):
        config = self._get_oauth_config()
        if not (config.client_id and config.client_secret):
            raise ValueError("Google Sheets is not configured")

        creds = Credentials(
            token=access_token,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=config.client_id,
            client_secret=config.client_secret,
            scopes=SCOPES,
        )
        return build("sheets", "v4", credentials=creds)

    def refresh_access_token(self, refresh_token: str) -> dict[str, Any]:
        config = self._get_oauth_config()
        if not (config.client_id and config.client_secret):
            raise ValueError("Google Sheets is not configured")

        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=config.client_id,
            client_secret=config.client_secret,
            scopes=SCOPES,
        )
        creds.refresh(Request())
        expiry = creds.expiry or datetime.now(tz=timezone.utc) + timedelta(hours=1)
        return {
            "access_token": creds.token,
            "token_expiry": expiry,
        }

    @staticmethod
    def extract_spreadsheet_id(url_or_id: str) -> str:
        """Extract spreadsheet ID from Google Sheets URL or return as-is if already an ID."""
        match = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", url_or_id)
        if match:
            return match.group(1)
        return url_or_id.strip()

    @staticmethod
    def build_spreadsheet_url(
        spreadsheet_id: str, sheet_gid: int | None = None
    ) -> str:
        base_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit"
        if sheet_gid is None:
            return base_url
        return f"{base_url}#gid={sheet_gid}"

    def get_spreadsheet(
        self,
        access_token: str,
        refresh_token: str | None,
        url_or_id: str,
    ) -> dict[str, Any]:
        spreadsheet_id = self.extract_spreadsheet_id(url_or_id)
        service = self._build_service(access_token, refresh_token)
        metadata = (
            service.spreadsheets()
            .get(
                spreadsheetId=spreadsheet_id,
                fields="spreadsheetId,properties(title)",
            )
            .execute()
        )
        return {
            "spreadsheet_id": metadata["spreadsheetId"],
            "title": metadata.get("properties", {}).get("title"),
            "spreadsheet_url": self.build_spreadsheet_url(metadata["spreadsheetId"]),
        }

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
        rows: list[list[Any]],
        sheet_name: str = "Sheet1",
    ) -> tuple[int, int]:
        """Overwrite data in a Google Sheet from A1."""
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

    def append_sheet(
        self,
        access_token: str,
        refresh_token: str | None,
        spreadsheet_id: str,
        headers: list[str],
        rows: list[list[Any]],
        sheet_name: str = "Sheet1",
        section_title: str | None = None,
    ) -> tuple[int, int]:
        """Append rows to a sheet; create the tab and header if missing/empty."""
        service = self._build_service(access_token, refresh_token)
        sheet_id = self.ensure_sheet(service, spreadsheet_id, sheet_name)

        # Read existing data to decide whether to include headers.
        existing = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=f"{sheet_name}!A:Z")
            .execute()
            .get("values", [])
        )

        def _norm_row(values: list[str]) -> list[str]:
            return [" ".join(str(v).strip().lower().split()) for v in values]

        header_norm = _norm_row(headers)
        has_rows = len(existing) > 0
        top_row_is_header = has_rows and _norm_row(existing[0][: len(headers)]) == header_norm
        any_header_row = any(
            _norm_row((row or [])[: len(headers)]) == header_norm for row in existing
        )

        # Guarantee header row exists once, and only once, at row 1 for new/empty sheets.
        if not has_rows:
            service.spreadsheets().values().update(
                spreadsheetId=spreadsheet_id,
                range=f"{sheet_name}!A1",
                valueInputOption="RAW",
                body={"values": [headers]},
            ).execute()
            existing = [headers]
            top_row_is_header = True
            any_header_row = True
        elif not top_row_is_header and not any_header_row:
            service.spreadsheets().batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={
                    "requests": [
                        {
                            "insertDimension": {
                                "range": {
                                    "sheetId": sheet_id,
                                    "dimension": "ROWS",
                                    "startIndex": 0,
                                    "endIndex": 1,
                                },
                                "inheritFromBefore": False,
                            }
                        }
                    ]
                },
            ).execute()
            service.spreadsheets().values().update(
                spreadsheetId=spreadsheet_id,
                range=f"{sheet_name}!A1",
                valueInputOption="RAW",
                body={"values": [headers]},
            ).execute()
            existing = [headers] + existing
            top_row_is_header = True

        values: list[list[str]] = []
        if existing:
            values.append([])
        if section_title:
            values.append([section_title])
        values.extend(rows)

        service.spreadsheets().values().append(
            spreadsheetId=spreadsheet_id,
            range=f"{sheet_name}!A1",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
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
