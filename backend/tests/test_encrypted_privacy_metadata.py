import pytest
from sqlalchemy import select
from test_recoverable_privacy import recovery,plan_setup,residency_setup,NOW
from app.domains.public_service.encrypted_privacy_export import EncryptedPrivacyExport,TOPICS,RECOVERY
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied


def test_authenticated_request_bound_metadata_never_exports_archive_contents(recovery):
    db,workflow,request=recovery
    workflow.execute(1,request,now=NOW);db.commit()
    result=EncryptedPrivacyExport(db,workflow.keyring).export(1)
    assert len(result['items'])==3
    assert {item['topic'] for item in result['items']}==TOPICS-{'public_service.residency.synthetic.v1','public_service.residency.reviewed.v1','public_service.residency.review_consent.v1'}
    assert 'private-holding' not in str(result) and 'ciphertext' not in str(result)
    assert result['complete_account_export'] is False
    workflow.restore(1,request,now=NOW);db.commit()
    assert len(EncryptedPrivacyExport(db,workflow.keyring).export(1)['items'])==3
    archive=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==RECOVERY))
    p=archive.payload;claims=workflow.keyring.open(p['ciphertext'],p['key_version'])
    claims['owner_id']=2
    ciphertext,version=workflow.keyring.seal(claims)
    archive.payload={**p,'ciphertext':ciphertext,'key_version':version};db.commit()
    with pytest.raises(BoundaryDenied):EncryptedPrivacyExport(db,workflow.keyring).export(1)


def test_historical_residency_verifies_linked_consent_without_granting_eligibility(residency_setup):
    from datetime import timedelta
    from app.domains.public_service.reviewed_residency import EVIDENCE
    from app.domains.public_service.residency import SyntheticResidencyProducer
    db,producer=residency_setup
    consent=producer.consent(db,1,'synthetic-consent','fixture_document_review',confirmed=True,now=NOW)
    db.commit()
    producer.ingest(db,2,1,consent.id,country='IN',evidence_type='fixture_document_review',
        reference_hash='a'*64,expires=NOW+timedelta(days=1),now=NOW)
    SyntheticResidencyProducer(producer.keyring).record(db,1,country='IN',evidence_reference='synthetic:doc',
        reviewer='synthetic:reviewer',now=NOW,expires=NOW+timedelta(days=1));db.commit()
    result=EncryptedPrivacyExport(db,producer.keyring).export(1)
    assert len(result['items'])==3 and all(item['eligibility_granted'] is False for item in result['items'])
    assert any(item.get('linked_consent_verified',False) for item in result['items'])
    p=consent.payload;bound=producer.keyring.open(p['ciphertext'],p['key_version']);bound['owner']=3
    ciphertext,version=producer.keyring.seal(bound)
    consent.payload={**p,'ciphertext':ciphertext,'key_version':version};db.commit()
    with pytest.raises(BoundaryDenied):EncryptedPrivacyExport(db,producer.keyring).export(1)


def test_unsealed_outer_state_cannot_escape_closed_metadata(recovery):
    from app.domains.public_service.encrypted_privacy_export import PLAN
    db,workflow,request=recovery
    workflow.execute(1,request,now=NOW);db.commit()
    row=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==PLAN))
    row.payload={**row.payload,'state':{'unexpected_private_content':'SYNTHETIC_DO_NOT_EXPORT'}};db.commit()
    with pytest.raises(BoundaryDenied):EncryptedPrivacyExport(db,workflow.keyring).export(1)


def test_new_unlinked_consent_is_searchable_but_legacy_opaque_consent_is_not_guessed(residency_setup):
    db,producer=residency_setup
    packet=producer.consent(db,1,'unlinked-synthetic','fixture_document_review',confirmed=True,now=NOW)
    db.commit()
    result=EncryptedPrivacyExport(db,producer.keyring).export(1)
    assert len(result['items'])==1 and result['items'][0]['consumed'] is False
    packet.payload={key:value for key,value in packet.payload.items() if key!='owner_id'};db.commit()
    assert EncryptedPrivacyExport(db,producer.keyring).export(1)['items']==[]
