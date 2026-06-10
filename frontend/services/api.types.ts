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
    PolymarketDiscoveryDebugReport,
    PolymarketDiscoveryDebugRequest,
    ZerodhaLoginUrlResponse,
    ZerodhaOrder,
    ZerodhaPrepareBasketRequest,
    ZerodhaPrepareBasketResponse,
    ZerodhaPlaceOrderRequest,
    ZerodhaPlaceOrderResponse,
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
    polymarketLiveEmergencyStop(): Promise<PolymarketBotState>;
    polymarketLiveResetEmergencyStop(): Promise<PolymarketBotState>;
    polymarketLiveTradeConfirm(tradeId: string): Promise<PolymarketBotState>;
    polymarketLiveTradeReject(tradeId: string): Promise<PolymarketBotState>;
    polymarketLiveRejectAll(): Promise<PolymarketBotState>;
    polymarketDiscoveryDebug(data: PolymarketDiscoveryDebugRequest): Promise<PolymarketDiscoveryDebugReport>;
}

// Type for API error handling
export interface ApiError {
    status: number;
    message: string;
    details?: HTTPValidationError;
    originalError?: unknown;
}
