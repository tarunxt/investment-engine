"""Stable catalogue. UI selection never grants an integration or trading right."""
from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType
from typing import Iterable

from pydantic import BaseModel, ConfigDict
from typing import Literal


class ModuleId(str, Enum):
    ZERODHA_REBALANCE = 'zerodha_rebalance'
    INDMONEY_US = 'indmoney_us'
    BULLPEN_RESEARCH = 'bullpen_research'
    BULLPEN_LIVE = 'bullpen_live'
    COPY_TRADER = 'copy_trader'
    PREDICTION_DIRECT = 'prediction_direct'
    MARKET_SCANNER = 'market_scanner'
    AI_STUDIO = 'ai_studio'
    SHEETS_EXPORT = 'sheets_export'
    SPORTS_RANKINGS = 'sports_rankings'


KNOWN_CAPABILITIES = frozenset({'view', 'analyze', 'import', 'export', 'execute'})


class ModuleConfigV1(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    schema_version: Literal[1] = 1


@dataclass(frozen=True)
class ModuleSpec:
    id: ModuleId
    label: str
    category: str
    capabilities: frozenset[str]
    connection: str = 'none'
    available: bool = True
    unavailable_reason: str | None = None
    requires: tuple[ModuleId, ...] = ()


def validate_catalogue(specs: Iterable[ModuleSpec]) -> dict[ModuleId, ModuleSpec]:
    specs = list(specs)
    if any(not isinstance(s.id, ModuleId) for s in specs):
        raise ValueError("Unknown module ID")
    if any(not s.capabilities <= KNOWN_CAPABILITIES for s in specs):
        raise ValueError("Unknown module capability")
    result = {s.id: s for s in specs}
    if len(result) != len(specs):
        raise ValueError('Duplicate module ID')
    visited, visiting = set(), set()
    def visit(id):
        if id not in result:
            raise ValueError('Unknown module dependency')
        if id in visiting:
            raise ValueError('Cyclic module dependency')
        if id in visited:
            return
        visiting.add(id)
        for dependency in result[id].requires:
            visit(dependency)
        visiting.remove(id)
        visited.add(id)
    for id in result:
        visit(id)
    return result


_VIEW_ANALYSIS = frozenset({'view', 'analyze'})
_CLOSED = 'Public singleton runtime/research is not approved; existing operator policy is separate'
REGISTRY = MappingProxyType(validate_catalogue([
    ModuleSpec(ModuleId.ZERODHA_REBALANCE, 'Zerodha Rebalance', 'investing', _VIEW_ANALYSIS | {'execute'}, 'kite'),
    ModuleSpec(ModuleId.INDMONEY_US, 'INDmoney US', 'investing', _VIEW_ANALYSIS | {'import'}, 'manual_import'),
    ModuleSpec(ModuleId.BULLPEN_RESEARCH, 'Bullpen Research', 'research', _VIEW_ANALYSIS, 'singleton_operator', False, _CLOSED),
    ModuleSpec(ModuleId.BULLPEN_LIVE, 'Bullpen Live', 'operator', frozenset({'view', 'execute'}), 'singleton_operator', False, _CLOSED),
    ModuleSpec(ModuleId.COPY_TRADER, 'Copy Trader', 'operator', frozenset({'view', 'execute'}), 'singleton_operator', False, _CLOSED),
    ModuleSpec(ModuleId.PREDICTION_DIRECT, 'Prediction Direct', 'operator', frozenset({'view', 'execute'}), 'singleton_operator', False, _CLOSED),
    ModuleSpec(ModuleId.MARKET_SCANNER, 'Market Scanner', 'research', _VIEW_ANALYSIS),
    ModuleSpec(ModuleId.AI_STUDIO, 'AI Studio', 'analysis', _VIEW_ANALYSIS, 'ai_provider'),
    ModuleSpec(ModuleId.SHEETS_EXPORT, 'Sheets Export', 'connections', frozenset({'view', 'export'}), 'google_sheets'),
    ModuleSpec(ModuleId.SPORTS_RANKINGS, 'Sports Rankings', 'research', frozenset({'view'})),
]))

# Always available after normal authentication/ownership, without optional selection.
CORE_CAPABILITIES = frozenset({'profile.read', 'profile.write', 'preferences.read',
    'preferences.write', 'connections.manage', 'usage.personal.read', 'safety.activity.read'})

# These are internal consumer dependencies, never dependencies on standalone UI.
INTERNAL_ANALYSIS_CONSUMERS = frozenset({ModuleId.ZERODHA_REBALANCE, ModuleId.INDMONEY_US,
    ModuleId.BULLPEN_RESEARCH, ModuleId.MARKET_SCANNER, ModuleId.AI_STUDIO})
INTERNAL_ANALYSIS_CAPABILITIES = frozenset({'analysis.technical', 'analysis.structured'})


@dataclass(frozen=True)
class SimulationAvailability:
    """Server-issued scoped simulation fact; never a residency/provider grant."""
    owner_id: int


def platform_available(module: ModuleSpec, *, uat2: bool, simulation=None, owner_id=None) -> tuple[bool, str | None]:
    if not module.available:
        return False, module.unavailable_reason
    if uat2:
        if (type(simulation) is SimulationAvailability and type(owner_id) is int
                and simulation.owner_id == owner_id and owner_id > 0
                and module.id in {ModuleId.ZERODHA_REBALANCE, ModuleId.INDMONEY_US}):
            return True, 'Owner-scoped synthetic simulation only; no real integration or residency approval'
        return False, 'Optional module operations are not mounted in the restricted UAT2 simulation'
    return True, None
