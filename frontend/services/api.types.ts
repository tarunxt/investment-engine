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
    healthCheck(): Promise<Record<string, any>>;
    healthCheckDB(): Promise<Record<string, any>>;
    healthCheckRedis(): Promise<Record<string, any>>;
    healthCheckFull(): Promise<FullHealthCheckResponse>;

    // Job endpoints
    createJob(data: JobCreate): Promise<JobResponse>;
    getJobs(params?: { page?: number; page_size?: number; status?: string; q?: string }): Promise<PaginatedResponse<JobResponse>>;
    getJob(id: number): Promise<JobResponse>;

    // Provider endpoints
    getProviders(): Promise<ProviderInfo[]>;

    // Prompt endpoints
    getPrompts(params?: { q?: string }, signal?: AbortSignal): Promise<PromptResponse[]>;
    getPrompt(id: number): Promise<PromptResponse>;
    createPrompt(data: PromptCreate): Promise<PromptResponse>;
    updatePrompt(id: number, data: PromptUpdate): Promise<PromptResponse>;
    deletePrompt(id: number): Promise<void>;
}

// Type for API error handling
export interface ApiError {
    status: number;
    message: string;
    details?: HTTPValidationError;
    originalError?: unknown;
}
