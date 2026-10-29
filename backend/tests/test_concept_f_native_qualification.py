"""Prevent a CI wrapper from converting skips/stale/hosted labels into native evidence."""
import json,tempfile
from pathlib import Path
import pytest
from scripts.public_launch.concept_f_native_qualification import CASES,evidence_path,verify_case
SHA='a'*40
BASE={'passed':True,'source_binding_verified':True,'source_sha':SHA,'harness_sha':SHA,'sqlite':True,'postgresql':False,'redis':False,'hosted':False,'checks':['actual_owner_assertion']}
def test_native_matrix_is_unique_and_retains_risk_onboarding_import_unknown_and_capture():
 names=[row[0] for row in CASES];assert len(names)==19 and len(set(names))==19
 assert {'profile','onboarding','threats','us-import','safety-partial','safety-before_acceptance','screen-capture'}<=set(names)
 matrix={row[0]:row for row in CASES};assert matrix['safety-filled'][1]=='concept-f-safety'
 assert matrix['safety-partial'][1]==matrix['safety-before_acceptance'][1]=='concept-f-safety'
def test_exact_native_receipts_cannot_promote_stale_or_hosted_or_skipped_evidence(tmp_path):
 junit=tmp_path/'junit.xml';junit.write_text('<testsuites><testsuite><testcase name="actual"/></testsuite></testsuites>');verify_case(BASE,junit,SHA)
 for changes in [{'passed':False},{'source_binding_verified':False},{'source_sha':'b'*40},{'harness_sha':'b'*40},{'postgresql':True},{'redis':True},{'hosted':True},{'checks':[]}]:
  with pytest.raises(ValueError):verify_case({**BASE,**changes},junit,SHA)
 for extra in ['<skipped/>','<failure/>','<error/>']:
  junit.write_text('<testsuites><testsuite><testcase>'+extra+'</testcase></testsuite></testsuites>')
  with pytest.raises(ValueError):verify_case(BASE,junit,SHA)
def test_evidence_path_cannot_overwrite_workspace_or_follow_external_symlink(tmp_path):
 assert str(evidence_path('/tmp/credx-native-synthetic-proof')).startswith('/tmp/')
 for value in ['relative','/Users/private','/tmp/../etc/passwd']:
  with pytest.raises(ValueError):evidence_path(value)
 with tempfile.TemporaryDirectory(prefix='credx-evidence-guard-',dir='/tmp') as directory:
  link=Path(directory)/'outside';link.symlink_to(Path('/etc'))
  for target in [link,link/'child']:
   with pytest.raises(ValueError):evidence_path(str(target))

def test_normal_native_workspace_requires_actual_actions_source_and_original_zoom_restore():
 from scripts.public_launch.concept_f_native_qualification import verify_native_workspace_observation
 base='http://localhost:54321';value={'source_sha':SHA,'start_url':base+'/console/dashboard','visible_build_prefix':SHA[:12],'normal_profile':True,'native_zoom_percent':200,'keyboard_primary_focus':'Review exact instructions','primary_destination':base+'/console/profile/activity#order-review-heading','keyboard_refresh_focus':'Review recorded status','refresh_activated':True,'created_tab_closed':True,'existing_user_tabs_untouched':True,'original_zoom_percent':100,'restored_zoom_percent':100}
 verify_native_workspace_observation(value,SHA,base)
 for patch in [{'source_sha':'b'*40},{'normal_profile':False},{'native_zoom_percent':True},{'keyboard_primary_focus':'not verified'},{'refresh_activated':False},{'primary_destination':'https://cred-x.in/console/profile/activity'},{'created_tab_closed':False},{'restored_zoom_percent':80},{'original_zoom_percent':True}]:
  with pytest.raises(ValueError):verify_native_workspace_observation({**value,**patch},SHA,base)
