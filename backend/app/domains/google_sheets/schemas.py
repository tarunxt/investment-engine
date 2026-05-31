from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class GoogleSheetsAuthUrlResponse(BaseModel):
    auth_url: str
    configured: bool
    redirect_uri: Optional[str] = None


class GoogleSheetsStatusResponse(BaseModel):
    connected: bool
    token_expiry: Optional[datetime] = None
    default_spreadsheet_url: Optional[str] = None


class GoogleSheetsDefaultSheetRequest(BaseModel):
    spreadsheet_url: Optional[str] = None
    title: Optional[str] = None


class GoogleSheetsDefaultSheetResponse(BaseModel):
    spreadsheet_url: str
    created_new: bool = False


class GoogleSheetsExportJobRequest(BaseModel):
    job_id: int
    spreadsheet_url: Optional[str] = None
    sheet_name: str = "Stock Ideas"
    title: str = "Investment Analysis Export"
    investment_amount: str = "INR 10,000"


class GoogleSheetsExportRunRequest(BaseModel):
    run_id: int
    spreadsheet_url: Optional[str] = None
    sheet_name: str = "Stock Ideas"
    title: str = "Investment Analysis Export"
    investment_amount: str = "INR 10,000"


class GoogleSheetsImportRequest(BaseModel):
    spreadsheet_url: str
    sheet_name: str = "Sheet1"


class GoogleSheetsExportResponse(BaseModel):
    status: str
    message: str
    spreadsheet_url: Optional[str] = None
    task_id: Optional[str] = None
