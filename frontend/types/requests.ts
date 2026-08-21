import { UserRegisterRequest, UserLoginRequest, UpdatePasswordRequest, UpdateProfileRequest, JobCreate } from './api';

// Re-export for convenience
export type {
  UserRegisterRequest,
  UserLoginRequest,
  UpdatePasswordRequest,
  UpdateProfileRequest,
  JobCreate,
};

// Additional request types for specific use cases
export interface RefreshTokenRequestBody {
  refresh_token: string;
}

export interface CreateJobRequest {
  prompt: string;
  provider: string;
  model: string;
}

export interface LoginRequestBody {
  email?: string;
  username?: string;
  password: string;
}

export interface RegisterRequestBody {
  email: string;
  username: string;
  password: string;
  full_name?: string;
}

export interface UpdatePasswordRequestBody {
  current_password: string;
  new_password: string;
  confirm_password: string;
}

export interface UpdateProfileRequestBody {
  full_name?: string;
  avatar_url?: string;
  bio?: string;
  timezone?: string;
  notification_preferences?: string;
  theme_preference?: string;
}