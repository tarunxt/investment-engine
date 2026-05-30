import {
    LoginResponse,
    RegisterResponse,
    UserResponse,
    JobResponse,
    JobCreate,
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
    ZerodhaLoginUrlResponse,
    ZerodhaOrder,
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

    // Provider endpoints
    getProviders({ signal, prompt }: { signal?: AbortSignal; prompt?: string }): Promise<ProviderInfo[]>;

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
    indmoneyUsEventsLatest(): Promise<IndMoneyUsEventsLatestResponse>;
    indmoneyUsEventsHistory(params?: { limit?: number }): Promise<IndMoneyUsEventsHistoryResponse>;
    indmoneyUsEventJob(jobId: number): Promise<IndMoneyUsEventsAnalysis>;
    indmoneyUsRunEvents(data?: PortfolioEventRunRequest): Promise<IndMoneyUsEventsRunResponse>;
    indmoneyUsThreatsLatest(): Promise<IndMoneyUsThreatLatestResponse>;
    indmoneyUsThreatsHistory(params?: { limit?: number }): Promise<IndMoneyUsThreatHistoryResponse>;
    indmoneyUsThreatJob(jobId: number): Promise<IndMoneyUsThreatAnalysis>;
    indmoneyUsRunThreats(data?: PortfolioEventRunRequest): Promise<IndMoneyUsThreatRunResponse>;
}

// Type for API error handling
export interface ApiError {
    status: number;
    message: string;
    details?: HTTPValidationError;
    originalError?: unknown;
}
