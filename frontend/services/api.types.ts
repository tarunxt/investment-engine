import {
    LoginResponse,
    LlmPerformanceResponse,
    RegisterResponse,
    UserResponse,
    JobResponse,
    JobCreate,
    GoogleSheetsAdminConfigResponse,
    GoogleSheetsAdminConfigUpdateRequest,
    GoogleSheetsAuthUrlResponse,
    GoogleSheetsDefaultSheetRequest,
    GoogleSheetsDefaultSheetResponse,
    GoogleSheetsExportJobRequest,
    GoogleSheetsExportResponse,
    GoogleSheetsExportRunRequest,
    GoogleSheetsImportRequest,
    GoogleSheetsStatusResponse,
    UpdateProfileRequest,
    UpdatePasswordRequest,
    HTTPValidationError,
    FullHealthCheckResponse,
    RefreshTokenResponse,
    PaginatedResponse,
    PromptResponse,
    PromptCreate,
    PromptUpdate,
    ProviderInfo,
    PortfolioEventRunRequest,
    ZerodhaEventsAnalysis,
    ZerodhaEventsHistoryResponse,
    ZerodhaEventsLatestResponse,
    ZerodhaEventsRunResponse,
    IndMoneyUsCurrentPricesRequest,
    IndMoneyUsCurrentPricesResponse,
    IndMoneyUsPortfolioOverviewResponse,
    IndMoneyUsPortfolioSnapshotCreateRequest,
    IndMoneyUsPortfolioSnapshotDetail,
    IndMoneyUsEventsAnalysis,
    IndMoneyUsEventsHistoryResponse,
    IndMoneyUsEventsLatestResponse,
    IndMoneyUsEventsRunResponse,
    IndMoneyUsThreatAnalysis,
    IndMoneyUsThreatHistoryResponse,
    IndMoneyUsThreatLatestResponse,
    IndMoneyUsThreatRunResponse,
    PolymarketBotState,
    PolymarketManualInvestOrderRequest,
    PolymarketManualInvestResponse,
    PolymarketLiveLimitUpdate,
    PolymarketTrackedAccountCreate,
    PolymarketTrackedAccountUpdate,
    PolymarketDiscoveryDebugReport,
    PolymarketDiscoveryDebugRequest,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
    BullpenAutoLiveRun,
    BullpenAutoLiveRunOrdersResponse,
    BullpenAutoLiveRunOnceRequest,
    BullpenAutoLiveDecision,
    BullpenAutoLiveState,
    BullpenAutoLiveSummaryResponse,
    BullpenRunAuditDetailResponse,
    BullpenRunAuditFeedbackCreateRequest,
    BullpenRunAuditFeedbackDetail,
    BullpenRunAuditFeedbackSummary,
    BullpenRunAuditFinding,
    BullpenRunAuditListResponse,
    BullpenRunAuditManualCheck,
    BullpenRunAuditManualCheckUpdateRequest,
    BullpenRunAuditMaterializeResponse,
    BullpenRunAuditRemark,
    BullpenRunAuditRemarkCreateRequest,
    BullpenRunAuditSectionResponse,
    TradingBotsSummaryResponse,
    TradingBotsOverviewResponse,
    ZerodhaLoginUrlResponse,
    ZerodhaOrder,
    ZerodhaPrepareBasketRequest,
    ZerodhaPrepareBasketResponse,
    ZerodhaPlaceOrderRequest,
    ZerodhaPlaceOrderResponse,
  ZerodhaProtectedMarketRequest,
  ZerodhaProtectedMarketResponse,
  ZerodhaSequencedProtectedMarketRequest,
  ZerodhaSequencedProtectedMarketResponse,
    ZerodhaThreatAnalysis,
    ZerodhaThreatHistoryResponse,
    ZerodhaThreatLatestResponse,
    ZerodhaThreatRunResponse,
    ZerodhaPortfolioOverviewResponse,
    ZerodhaPortfolioSnapshotDetail,
    ZerodhaPortfolioSyncResponse,
    ZerodhaStatusResponse,
    RunListItem,
    RunResponse,
} from '@/types/api';

// Define the API service interface with proper types
export interface IApiService {
    // Auth endpoints
    login(data: { email?: string; username?: string; password: string }): Promise<LoginResponse>;
    register(data: { email: string; username: string; password: string; full_name?: string }): Promise<RegisterResponse>;
    logout(token?: string): Promise<void>;
    refreshToken(refreshToken: string): Promise<RefreshTokenResponse>;
    getCurrentUser(token?: string): Promise<UserResponse>;
    updatePassword(data: UpdatePasswordRequest, token?: string): Promise<void>;
    getProfile(token?: string): Promise<UpdateProfileRequest>;
    updateProfile(data: UpdateProfileRequest, token?: string): Promise<void>;
    forgotPassword(data: { email: string }): Promise<{ message: string }>;
    resetPassword(data: { token: string; new_password: string; confirm_password: string }): Promise<{ message: string }>;
    
    // Health endpoints
    healthCheck(): Promise<Record<string, unknown>>;
    healthCheckDB(): Promise<Record<string, unknown>>;
    healthCheckRedis(): Promise<Record<string, unknown>>;
    healthCheckFull(): Promise<FullHealthCheckResponse>;

    // Job endpoints
    createJob(data: JobCreate): Promise<JobResponse>;
    getJobs(params?: { page?: number; limit?: number; status?: string; q?: string }): Promise<PaginatedResponse<JobResponse>>;
    getJob(id: number): Promise<JobResponse>;
    getRuns(params?: { page?: number; limit?: number; summary?: boolean }): Promise<PaginatedResponse<RunListItem>>;
    getFullRuns(params?: { page?: number; limit?: number }): Promise<PaginatedResponse<RunResponse>>;

    // Provider endpoints
    getProviders({ signal, prompt }: { signal?: AbortSignal; prompt?: string }): Promise<ProviderInfo[]>;
    getLlmPerformance(params?: { limit?: number }): Promise<LlmPerformanceResponse>;

    // Google Sheets endpoints
    googleSheetsAuthUrl(): Promise<GoogleSheetsAuthUrlResponse>;
    googleSheetsAdminConfig(): Promise<GoogleSheetsAdminConfigResponse>;
    googleSheetsUpdateAdminConfig(data: GoogleSheetsAdminConfigUpdateRequest): Promise<GoogleSheetsAdminConfigResponse>;
    googleSheetsExchangeCode(code: string): Promise<{ status: string; message: string }>;
    googleSheetsStatus(): Promise<GoogleSheetsStatusResponse>;
    googleSheetsDisconnect(): Promise<{ message: string }>;
    googleSheetsSaveDefaultSheet(data: GoogleSheetsDefaultSheetRequest): Promise<GoogleSheetsDefaultSheetResponse>;
    googleSheetsExportJob(data: GoogleSheetsExportJobRequest): Promise<GoogleSheetsExportResponse>;
    googleSheetsExportRun(data: GoogleSheetsExportRunRequest): Promise<GoogleSheetsExportResponse>;
    googleSheetsImport(data: GoogleSheetsImportRequest): Promise<GoogleSheetsExportResponse>;

    // Prompt endpoints
    getPrompts(params?: { q?: string }, signal?: AbortSignal): Promise<PromptResponse[]>;
    getPrompt(id: number): Promise<PromptResponse>;
    createPrompt(data: PromptCreate): Promise<PromptResponse>;
    updatePrompt(id: number, data: PromptUpdate): Promise<PromptResponse>;
    deletePrompt(id: number): Promise<void>;

    // Zerodha endpoints
    zerodhaLoginUrl(): Promise<ZerodhaLoginUrlResponse>;
    zerodhaCallback(request_token: string): Promise<ZerodhaStatusResponse>;
    zerodhaStatus(): Promise<ZerodhaStatusResponse>;
    zerodhaPortfolioOverview(): Promise<ZerodhaPortfolioOverviewResponse>;
    zerodhaPortfolioSnapshot(snapshotDate: string): Promise<ZerodhaPortfolioSnapshotDetail>;
    zerodhaSyncPortfolio(): Promise<ZerodhaPortfolioSyncResponse>;
    zerodhaOrders(): Promise<{ data: ZerodhaOrder[] }>;
    zerodhaPrepareBasketOrders(data: ZerodhaPrepareBasketRequest): Promise<ZerodhaPrepareBasketResponse>;
    zerodhaPlaceOrder(data: ZerodhaPlaceOrderRequest): Promise<ZerodhaPlaceOrderResponse>;
    zerodhaPlaceProtectedMarketOrders(data: ZerodhaProtectedMarketRequest): Promise<ZerodhaProtectedMarketResponse>;
    zerodhaPlaceProtectedMarketOrdersSequenced(data: ZerodhaSequencedProtectedMarketRequest): Promise<ZerodhaSequencedProtectedMarketResponse>;
    zerodhaDisconnect(): Promise<{ message: string }>;
    zerodhaEventsLatest(): Promise<ZerodhaEventsLatestResponse>;
    zerodhaEventsHistory(params?: { limit?: number }): Promise<ZerodhaEventsHistoryResponse>;
    zerodhaEventJob(jobId: number): Promise<ZerodhaEventsAnalysis>;
    zerodhaRunEvents(data?: PortfolioEventRunRequest): Promise<ZerodhaEventsRunResponse>;
    zerodhaThreatsLatest(): Promise<ZerodhaThreatLatestResponse>;
    zerodhaThreatsHistory(params?: { limit?: number }): Promise<ZerodhaThreatHistoryResponse>;
    zerodhaThreatJob(jobId: number): Promise<ZerodhaThreatAnalysis>;
    zerodhaRunThreats(data?: PortfolioEventRunRequest): Promise<ZerodhaThreatRunResponse>;

    // INDmoney US endpoints
    indmoneyUsPortfolioOverview(): Promise<IndMoneyUsPortfolioOverviewResponse>;
    indmoneyUsPortfolioSnapshot(snapshotId: number): Promise<IndMoneyUsPortfolioSnapshotDetail>;
    indmoneyUsCreatePortfolioSnapshot(
        data: IndMoneyUsPortfolioSnapshotCreateRequest,
    ): Promise<IndMoneyUsPortfolioSnapshotDetail>;
    indmoneyUsCurrentPrices(data: IndMoneyUsCurrentPricesRequest): Promise<IndMoneyUsCurrentPricesResponse>;
    indmoneyUsEventsLatest(): Promise<IndMoneyUsEventsLatestResponse>;
    indmoneyUsEventsHistory(params?: { limit?: number }): Promise<IndMoneyUsEventsHistoryResponse>;
    indmoneyUsEventJob(jobId: number): Promise<IndMoneyUsEventsAnalysis>;
    indmoneyUsRunEvents(data?: PortfolioEventRunRequest): Promise<IndMoneyUsEventsRunResponse>;
    indmoneyUsThreatsLatest(): Promise<IndMoneyUsThreatLatestResponse>;
    indmoneyUsThreatsHistory(params?: { limit?: number }): Promise<IndMoneyUsThreatHistoryResponse>;
    indmoneyUsThreatJob(jobId: number): Promise<IndMoneyUsThreatAnalysis>;
    indmoneyUsRunThreats(data?: PortfolioEventRunRequest): Promise<IndMoneyUsThreatRunResponse>;

    // Polymarket endpoints
    polymarketState(): Promise<PolymarketBotState>;
    polymarketStart(): Promise<PolymarketBotState>;
    polymarketStop(): Promise<PolymarketBotState>;
    polymarketPause(): Promise<PolymarketBotState>;
    polymarketResume(): Promise<PolymarketBotState>;
    polymarketLiveUnlock(): Promise<PolymarketBotState>;
    polymarketLiveLock(): Promise<PolymarketBotState>;
    polymarketLiveDoctor(): Promise<PolymarketBotState>;
    polymarketLiveBalanceRefresh(): Promise<PolymarketBotState>;
    polymarketLiveRedeem(data?: { conditionIds?: string[] }): Promise<PolymarketBotState>;
    polymarketLiveEmergencyStop(): Promise<PolymarketBotState>;
    polymarketLiveResetEmergencyStop(): Promise<PolymarketBotState>;
    polymarketUpdateLiveLimits(data: PolymarketLiveLimitUpdate): Promise<PolymarketBotState>;
    polymarketLiveTradeConfirm(tradeId: string): Promise<PolymarketBotState>;
    polymarketLiveTradeReject(tradeId: string): Promise<PolymarketBotState>;
    polymarketLiveRejectAll(): Promise<PolymarketBotState>;
    polymarketManualInvest(data: { orders: PolymarketManualInvestOrderRequest[] }): Promise<PolymarketManualInvestResponse>;
    polymarketAddTrackedAccount(data: PolymarketTrackedAccountCreate): Promise<PolymarketBotState>;
    polymarketUpdateTrackedAccount(accountId: string, data: PolymarketTrackedAccountUpdate): Promise<PolymarketBotState>;
    polymarketDeleteTrackedAccount(accountId: string): Promise<PolymarketBotState>;
    polymarketDiscoveryDebug(data: PolymarketDiscoveryDebugRequest): Promise<PolymarketDiscoveryDebugReport>;
    getBullpenAutoLiveSummary(): Promise<BullpenAutoLiveSummaryResponse>;
    getBullpenAutoLiveState(): Promise<BullpenAutoLiveState>;
    getBullpenAutoLiveSettings(): Promise<BullpenAutoLiveSettings>;
    updateBullpenAutoLiveSettings(data: BullpenAutoLiveSettingsUpdate): Promise<BullpenAutoLiveSettings>;
    resetBullpenAutoLiveSettings(): Promise<BullpenAutoLiveSettings>;
    getBullpenAutoLiveRuns(): Promise<BullpenAutoLiveRun[]>;
    getBullpenAutoLiveRunOrders(runId: string): Promise<BullpenAutoLiveRunOrdersResponse>;
    reconcileBullpenAutoLiveRunOrders(runId: string): Promise<BullpenAutoLiveRunOrdersResponse>;
    getBullpenAutoLiveDecisions(): Promise<BullpenAutoLiveDecision[]>;
    retryBullpenAutoLiveOrder(intentId: string): Promise<BullpenAutoLiveRunOrdersResponse>;
    cancelBullpenAutoLiveOrder(intentId: string): Promise<BullpenAutoLiveRunOrdersResponse>;
    getBullpenRunAudits(params?: {
        page?: number;
        limit?: number;
        status?: string;
        triggeredBy?: string;
        dryLiveMode?: string;
        fromDate?: string;
        toDate?: string;
        stageFailure?: string;
        auditStatus?: string;
        findingSeverity?: string;
        feedbackGenerated?: boolean;
        runIdSearch?: string;
    }): Promise<BullpenRunAuditListResponse>;
    getBullpenRunAuditDetail(runId: string): Promise<BullpenRunAuditDetailResponse>;
    materializeBullpenRunAudit(runId: string): Promise<BullpenRunAuditMaterializeResponse>;
    getBullpenRunAuditSection(runId: string, section: string): Promise<BullpenRunAuditSectionResponse>;
    getBullpenRunAuditFindings(runId: string): Promise<BullpenRunAuditFinding[]>;
    addBullpenRunAuditRemark(
        runId: string,
        data: BullpenRunAuditRemarkCreateRequest,
    ): Promise<BullpenRunAuditRemark>;
    updateBullpenRunAuditManualCheck(
        runId: string,
        data: BullpenRunAuditManualCheckUpdateRequest,
    ): Promise<BullpenRunAuditManualCheck>;
    createBullpenRunAuditFeedback(
        runId: string,
        data: BullpenRunAuditFeedbackCreateRequest,
    ): Promise<BullpenRunAuditFeedbackSummary>;
    getBullpenRunAuditFeedback(runId: string): Promise<BullpenRunAuditFeedbackSummary[]>;
    getBullpenRunAuditFeedbackDetail(
        runId: string,
        feedbackId: number,
    ): Promise<BullpenRunAuditFeedbackDetail>;
    exportBullpenRunAudit(runId: string): Promise<Record<string, unknown>>;
    runBullpenAutoLiveOnce(data?: BullpenAutoLiveRunOnceRequest): Promise<BullpenAutoLiveRun>;
    startBullpenAutoLive(): Promise<BullpenAutoLiveState>;
    stopBullpenAutoLive(): Promise<BullpenAutoLiveState>;
    pauseBullpenAutoLive(): Promise<BullpenAutoLiveState>;
    resumeBullpenAutoLive(): Promise<BullpenAutoLiveState>;
    emergencyStopBullpenAutoLive(): Promise<BullpenAutoLiveState>;
    clearEmergencyStopBullpenAutoLive(): Promise<BullpenAutoLiveState>;
    getTradingBotsSummary(): Promise<TradingBotsSummaryResponse>;
    cancelJob(id: number): Promise<JobResponse>;

    // Legacy aliases kept for existing callers.
    bullpenAiAutoLiveSummary(): Promise<BullpenAutoLiveSummaryResponse>;
    bullpenAiAutoLiveState(): Promise<BullpenAutoLiveState>;
    bullpenAiAutoLiveSettings(): Promise<BullpenAutoLiveSettings>;
    bullpenAiAutoLiveUpdateSettings(data: BullpenAutoLiveSettingsUpdate): Promise<BullpenAutoLiveSettings>;
    bullpenAiAutoLiveResetSettings(): Promise<BullpenAutoLiveSettings>;
    bullpenAiAutoLiveRuns(): Promise<BullpenAutoLiveRun[]>;
    bullpenAiAutoLiveRunOrders(runId: string): Promise<BullpenAutoLiveRunOrdersResponse>;
    bullpenAiAutoLiveReconcileRunOrders(runId: string): Promise<BullpenAutoLiveRunOrdersResponse>;
    bullpenAiAutoLiveDecisions(): Promise<BullpenAutoLiveDecision[]>;
    bullpenAiAutoLiveRetryOrder(intentId: string): Promise<BullpenAutoLiveRunOrdersResponse>;
    bullpenAiAutoLiveCancelOrder(intentId: string): Promise<BullpenAutoLiveRunOrdersResponse>;
    bullpenAiAutoLiveRunOnce(data?: BullpenAutoLiveRunOnceRequest): Promise<BullpenAutoLiveRun>;
    bullpenAiAutoLiveStart(): Promise<BullpenAutoLiveState>;
    bullpenAiAutoLiveStop(): Promise<BullpenAutoLiveState>;
    bullpenAiAutoLivePause(): Promise<BullpenAutoLiveState>;
    bullpenAiAutoLiveResume(): Promise<BullpenAutoLiveState>;
    bullpenAiAutoLiveEmergencyStop(): Promise<BullpenAutoLiveState>;
    bullpenAiAutoLiveClearEmergencyStop(): Promise<BullpenAutoLiveState>;
    getTradingBotsOverview(): Promise<TradingBotsOverviewResponse>;
}

// Type for API error handling
export interface ApiError {
    status: number;
    message: string;
    details?: HTTPValidationError;
    originalError?: unknown;
}
