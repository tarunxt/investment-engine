from itertools import combinations
from types import SimpleNamespace

from app.domains.scorecards import pair_plan as pp
from app.domains.scorecards.final import calculate_final, DEFAULT_WEIGHTS


def sample(n=34, ready=5):
    keys=[f"NSE:S{i:02d}" for i in range(n)]
    packets={k:{"features":{"sessions":60 if i<ready else 0,"return_5_pct":i if i<ready else None,
                            "issue":None if i<ready else "Missing candles"},"sources":{"1":{}} if i<ready else {}} for i,k in enumerate(keys)}
    return keys,{"stocks":[{"listing":k,"settled":1,"units":1} for k in keys]}, {"packets":packets}


def votes(keys, ready):
    assigned={}
    for a,b in combinations(keys,2):
        result=a if {a,b}<=set(keys[:ready]) else "UNKNOWN"
        assigned[(a,b)]={0:{"slot":1,"result":result,"source_refs":[],"job_id":1}}
    projected=pp.pair_results(assigned,keys)
    return [{"listing":k,**projected[k]} for k in keys]


def test_legacy_246_shape_and_partial_recovery():
    keys,manifest,old=sample()
    previous={"rows":votes(keys,5)}
    counts=pp.summarize(previous["rows"],old["packets"],"full",calls=1)
    assert [counts[k] for k in ("ready","expected","judged","returned","one_missing","both_missing","complete_stocks")]==[5,561,10,561,145,406,0]
    _,_,new=sample(34,6)
    selected,kept=pp.plan(keys,new,"full",previous,old["packets"])
    assert len(selected)==5 and len(kept)==10
    assert not set(selected)&kept.keys()
    output=pp.project_plan(manifest,new,"full",{"rows":[]},previous,old["packets"])
    assert output["pair_counts"]["judged"]==10 and output["pair_counts"]["eligible"]==15
    new["packets"][keys[0]]["features"]["return_5_pct"]=999
    selected,kept=pp.plan(keys,new,"full",previous,old["packets"])
    assert len(kept)==6 and len(selected)==9


def test_full_and_balanced_coverage_and_stage4_trial():
    keys,manifest,research=sample(34,34)
    full=pp.pair_schedule(keys)
    balanced=pp.pair_schedule(keys,"balanced")
    assert len(full)==561 and len(set(balanced))==136
    assert all(sum(k in p for p in balanced)==8 for k in keys)
    blocks=list(pp.assigned_batches(full))
    assert len(blocks)==24 and max(len(b) for _,b in blocks)==24
    assert [pair for _,block in blocks for pair in block]==full
    fresh={"rows":votes(keys,34),"errors":[]}
    output=pp.project_plan(manifest,research,"full",fresh,jobs=24)
    assert output["pair_counts"]["complete_stocks"]==34
    assert output["pair_counts"]["judged"]==561
    balanced_out=pp.project_plan(manifest,research,"balanced",fresh)
    assert balanced_out["pair_counts"]["judged"]==136
    cfg={"weights":{k:100 if k=="pairwise" else 0 for k in DEFAULT_WEIGHTS},"factors":{},"actions":{}}
    assert all(r["status"]=="Provisional" for r in calculate_final(manifest,{"pairwise":balanced_out},cfg))
    assert all(r["status"]=="Complete" for r in calculate_final(manifest,{"pairwise":output},cfg))


def test_legacy_unchanged_judgments_require_both_original_packets():
    keys,_,packets=sample(4,4)
    old={"rows":votes(keys,4)}
    del packets["packets"][keys[0]]
    selected,kept=pp.plan(keys,packets,"full",old,packets["packets"])
    assert len(kept)==3 and not selected
