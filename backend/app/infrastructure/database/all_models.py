# Import every ORM model so SQLAlchemy's mapper registry is fully populated
# before any query runs. Required in Celery workers (which don't load main.py).
from app.domains.cost_drivers.models import CostRecommendation, CostSnapshot, TrafficCostRollup  # noqa: F401
from app.domains.auth.models import User, UserProfile, UserSession, APIKey, ActivityLog  # noqa: F401
from app.domains.bullpen_trade_analysis.models import (  # noqa: F401
    BullpenTradeAnalysisEventLogRecord,
    BullpenTradeAnalysisLlmRecord,
    BullpenTradeAnalysisRecord,
    BullpenTradeAnalysisSnapshotRecord,
)
from app.domains.bullpen_run_audit.models import (  # noqa: F401
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
from app.domains.bullpen008.models import (  # noqa: F401
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
    Bullpen008ActionPlanRecord,
    Bullpen008AlertRecord,
    Bullpen008ExecutionAttemptRecord,
    Bullpen008ExecutionEventRecord,
    Bullpen008ExecutionIntentRecord,
    Bullpen008PortfolioCertificateRecord,
    Bullpen008RunRecord,
    Bullpen008SettingsRecord,
    Bullpen008StageOutputRecord,
    Bullpen008StateRecord,
)
from app.domains.google_sheets.models import GoogleSheetsAppConfig, GoogleSheetsCredential  # noqa: F401
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot  # noqa: F401
from app.domains.jobs.models import Job  # noqa: F401
from app.domains.polymarket.models import PolymarketRedeemAttemptRecord  # noqa: F401
from app.domains.polymarket_auto_live.models import (  # noqa: F401
    PolymarketAutoLiveCapitalReservationRecord,
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLiveOrderAttemptRecord,
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLivePositionRecord,
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveSettingsRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.runs.models import (  # noqa: F401
    AutoRebalanceWorkflow,
    AutoRebalanceWorkflowStage,
    Run,
    RunJob,
)
from app.domains.prompts.models import Prompt  # noqa: F401
from app.infrastructure.database.outbox.models import OutboxMessage  # noqa: F401
from app.domains.zerodha.audit import ZerodhaAuditLog  # noqa: F401
from app.domains.zerodha.models import ZerodhaCredential, ZerodhaPortfolioSnapshot  # noqa: F401
