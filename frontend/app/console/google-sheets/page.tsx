'use client';

import GoogleSheetsPanel from './_components/GoogleSheetsPanel';

export default function GoogleSheetsPage() {
  return (
    <div className="mx-auto flex flex-col gap-6">
      <GoogleSheetsPanel />

      <div className="border border-gray-200 bg-white shadow-sm rounded-lg p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-4">About Google Sheets Integration</h2>
        <div className="prose prose-sm text-gray-600 space-y-3">
          <p>
            Once connected, each user gets a personal Google Sheet that can receive AI-generated investment analysis, day-wise exports, and shared research tabs.
          </p>
          <p>
            An admin can complete the Google OAuth setup once on this page, after which every user simply clicks Connect Google Sheets.
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>Export individual job results (single AI analysis)</li>
            <li>Export run results (multi-LLM comparison analysis)</li>
            <li>Create a personal default sheet or link an existing spreadsheet</li>
            <li>Share results easily with your team</li>
          </ul>
          <p className="text-xs text-gray-500 mt-4">
            Your Google credentials are encrypted and securely stored. You can disconnect at any time.
          </p>
        </div>
      </div>
    </div>
  );
}
