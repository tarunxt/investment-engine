"""Canonical model imports for SQLAlchemy metadata discovery."""

from app.domains.auth.models import ActivityLog, APIKey, User, UserProfile, UserSession
from app.domains.bullpen_run_audit.models import (
    BullpenRunAuditBlobRecord,
    BullpenRunAuditEventRecord,
    BullpenRunAuditFeedbackRecord,
    BullpenRunAuditFeedbackSubcallRecord,
    BullpenRunAuditFindingRecord,
    BullpenRunAuditFormulaRecord,
    BullpenRunAuditManualCheckRecord,
    BullpenRunAuditRemarkRecord,
    BullpenRunAuditSnapshotRecord,
    BullpenRunAuditStageRecord,
)
from app.domains.bullpen_trade_analysis.models import (
    BullpenTradeAnalysisEventLogRecord,
    BullpenTradeAnalysisLlmRecord,
    BullpenTradeAnalysisRecord,
    BullpenTradeAnalysisSnapshotRecord,
)
from app.domains.cost_drivers.models import (
    CostRecommendation,
    CostSnapshot,
    TrafficCostRollup,
)
from app.domains.fx_rates.models import FxRate
from app.domains.google_sheets.models import (
    GoogleSheetsAppConfig,
    GoogleSheetsCredential,
)
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.jobs.models import Job
from app.domains.polymarket.models import PolymarketRedeemAttemptRecord
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLiveOrderAttemptRecord,
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLivePositionRecord,
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveSettingsRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.prompts.models import Prompt
from app.domains.runs.models import (
    AutoRebalanceWorkflow,
    AutoRebalanceWorkflowStage,
    Run,
    RunJob,
)
from app.domains.zerodha.audit import ZerodhaAuditLog
from app.domains.zerodha.models import ZerodhaCredential, ZerodhaPortfolioSnapshot
from app.infrastructure.database.outbox.models import OutboxMessage

__all__ = [
    "ActivityLog",
    "APIKey",
    "AutoRebalanceWorkflow",
    "AutoRebalanceWorkflowStage",
    "BullpenRunAuditBlobRecord",
    "BullpenRunAuditEventRecord",
    "BullpenRunAuditFeedbackRecord",
    "BullpenRunAuditFeedbackSubcallRecord",
    "BullpenRunAuditFindingRecord",
    "BullpenRunAuditFormulaRecord",
    "BullpenRunAuditManualCheckRecord",
    "BullpenRunAuditRemarkRecord",
    "BullpenRunAuditSnapshotRecord",
    "BullpenRunAuditStageRecord",
    "BullpenTradeAnalysisEventLogRecord",
    "BullpenTradeAnalysisLlmRecord",
    "BullpenTradeAnalysisRecord",
    "BullpenTradeAnalysisSnapshotRecord",
    "CostRecommendation",
    "CostSnapshot",
    "FxRate",
    "GoogleSheetsAppConfig",
    "GoogleSheetsCredential",
    "IndMoneyUsPortfolioSnapshot",
    "Job",
    "OutboxMessage",
    "PolymarketAutoLiveDecisionRecord",
    "PolymarketAutoLiveOrderAttemptRecord",
    "PolymarketAutoLiveOrderIntentRecord",
    "PolymarketAutoLivePositionRecord",
    "PolymarketAutoLiveRunRecord",
    "PolymarketAutoLiveSettingsRecord",
    "PolymarketAutoLiveStateRecord",
    "PolymarketRedeemAttemptRecord",
    "Prompt",
    "Run",
    "RunJob",
    "TrafficCostRollup",
    "User",
    "UserProfile",
    "UserSession",
    "ZerodhaAuditLog",
    "ZerodhaCredential",
    "ZerodhaPortfolioSnapshot",
]
