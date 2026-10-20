from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .registry import ModuleConfigV1, ModuleId


class ModuleUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    module_id: ModuleId
    enabled: bool = Field(strict=True)
    config: ModuleConfigV1 = Field(default_factory=ModuleConfigV1)


class ModulePatch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_version: int = Field(ge=0, strict=True)
    updates: list[ModuleUpdate] = Field(min_length=1, max_length=10)

    @model_validator(mode='after')
    def unique_updates(self):
        if len({u.module_id for u in self.updates}) != len(self.updates):
            raise ValueError('A module may be updated only once per patch')
        return self


class DisableImpactRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_version: int = Field(ge=0, strict=True)
    module_ids: list[ModuleId] = Field(min_length=1, max_length=10)

    @model_validator(mode='after')
    def unique_ids(self):
        if len(set(self.module_ids)) != len(self.module_ids):
            raise ValueError('Duplicate module IDs')
        return self


class ModuleDecision(BaseModel):
    allowed: bool
    reasons: list[str]
    owner_id: int
    module_id: str | None = None
    capability: str
    boundary: Literal['http', 'stream', 'worker', 'side_effect', 'internal']
    selection_version: int | None


class ModuleSelection(BaseModel):
    schedules_paused: bool = True
    enabled: bool
    version: int = Field(ge=0)
    config: ModuleConfigV1


class ModuleAvailability(BaseModel):
    available: bool
    reason: str | None


class ModuleEntitlement(BaseModel):
    jurisdiction: Literal['allowed','denied','unknown']
    plan: Literal['allowed','denied','unknown']


class ConnectionReadiness(BaseModel):
    kind: Literal['none','kite','manual_import','singleton_operator','ai_provider','google_sheets']
    state: Literal['ready','missing','unknown','not_required']


class ExecutionCapability(BaseModel):
    capable: bool
    action_confirmed: bool


class ModuleState(BaseModel):
    module_id: ModuleId
    label: str
    category: str
    selection: ModuleSelection
    availability: ModuleAvailability
    entitlement: ModuleEntitlement
    connection: ConnectionReadiness
    execution: ExecutionCapability
    requires: list[ModuleId]
    capabilities: dict[str, ModuleDecision]


class ModuleCollection(BaseModel):
    schema_version: Literal[1]
    owner_id: int = Field(gt=0)
    version: int = Field(ge=0)
    modules: list[ModuleState] = Field(min_length=10,max_length=10)
    operational_enforcement_complete: bool

    @model_validator(mode='after')
    def complete_registry(self):
        if {m.module_id for m in self.modules} != set(ModuleId):
            raise ValueError('Incomplete module registry response')
        return self


class DisabledModuleImpact(BaseModel):
    module_id: ModuleId
    currently_enabled: bool
    capabilities_disabled_by_policy: list[str]


class ActiveWorkImpact(BaseModel):
    status: Literal['not_inspected']
    analysis_inspected: bool = False
    reason: str
    queued_analysis: int = 0
    running_analysis: int = 0
    schedules_will_pause: bool = True


class DisableImpact(BaseModel):
    schema_version: Literal[1]
    owner_id: int = Field(gt=0)
    version: int = Field(ge=0)
    modules: list[DisabledModuleImpact]
    dependent_modules: list[ModuleId]
    data_and_connections_retained: Literal[True]
    changes_applied: Literal[False]
    active_work: ActiveWorkImpact
    core_account_features_retained: Literal[True]


class ResumeSchedulesRequest(BaseModel):
    model_config=ConfigDict(extra='forbid')
    expected_version:int=Field(ge=0,strict=True)
