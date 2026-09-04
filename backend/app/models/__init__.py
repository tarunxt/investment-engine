"""Canonical model imports for SQLAlchemy metadata discovery."""

from app.domains.auth.models import ActivityLog, APIKey, User, UserProfile, UserSession
from app.domains.api_usage.models import (
    LlmProviderUsageCallRecord,
    LlmProviderUsageDailySnapshot,
)
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
from app.domains.bullpen008.models import (
    Bullpen008ContingentExitActivationRecord,
    Bullpen008ContingentExitPolicyRecord,
    Bullpen008DailyEquityBaselineRecord,
    Bullpen008DrawdownEpisodeRecord,
    Bullpen008EvidencePacketRecord,
    Bullpen008JointLossScenarioRecord,
    Bullpen008LossPreventionAuditRecord,
    Bullpen008PnlAttributionRecord,
    Bullpen008QuoteObservationRecord,
    Bullpen008RegimeChangeEpisodeRecord,
    Bullpen008RiskClassificationRecord,
    Bullpen008ScenarioCooldownRecord,
    Bullpen008ScenarioExposureSnapshotRecord,
    Bullpen008ScenarioMembershipRecord,
    Bullpen008PortfolioCertificateRecord,
    Bullpen008RunRecord,
    Bullpen008SettingsRecord,
    Bullpen008StageOutputRecord,
    Bullpen008StateRecord,
)
from app.domains.bullpen_trade_analysis.models import (
    BullpenTradeAnalysisEventLogRecord,
    BullpenTradeAnalysisLlmRecord,
    BullpenTradeAnalysisRecord,
    BullpenTradeAnalysisSnapshotRecord,
)
from app.domains.dashboard.models import DashboardPortfolioDailySnapshot
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
    FinalActionableHistory,
    Run,
    RunJob,
)
from app.domains.zerodha.audit import ZerodhaAuditLog
from app.domains.zerodha.models import ZerodhaCredential, ZerodhaPortfolioSnapshot
from app.infrastructure.database.outbox.models import OutboxMessage

__all__ = [
    "Bullpen008ContingentExitActivationRecord",
    "Bullpen008ContingentExitPolicyRecord",
    "Bullpen008DailyEquityBaselineRecord",
    "Bullpen008DrawdownEpisodeRecord",
    "Bullpen008EvidencePacketRecord",
    "Bullpen008JointLossScenarioRecord",
    "Bullpen008LossPreventionAuditRecord",
    "Bullpen008PnlAttributionRecord",
    "Bullpen008QuoteObservationRecord",
    "Bullpen008RegimeChangeEpisodeRecord",
    "Bullpen008RiskClassificationRecord",
    "Bullpen008ScenarioCooldownRecord",
    "Bullpen008ScenarioExposureSnapshotRecord",
    "Bullpen008ScenarioMembershipRecord",
    "ActivityLog",
    "APIKey",
    "AutoRebalanceWorkflow",
    "AutoRebalanceWorkflowStage",
    "FinalActionableHistory",
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
    "Bullpen008PortfolioCertificateRecord",
    "Bullpen008RunRecord",
    "Bullpen008SettingsRecord",
    "Bullpen008StageOutputRecord",
    "Bullpen008StateRecord",
    "BullpenTradeAnalysisEventLogRecord",
    "BullpenTradeAnalysisLlmRecord",
    "BullpenTradeAnalysisRecord",
    "BullpenTradeAnalysisSnapshotRecord",
    "CostRecommendation",
    "DashboardPortfolioDailySnapshot",
    "CostSnapshot",
    "FxRate",
    "GoogleSheetsAppConfig",
    "GoogleSheetsCredential",
    "IndMoneyUsPortfolioSnapshot",
    "Job",
    "LlmProviderUsageCallRecord",
    "LlmProviderUsageDailySnapshot",
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
