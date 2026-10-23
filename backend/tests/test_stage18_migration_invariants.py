import unittest
from copy import deepcopy
from scripts.public_launch.stage18_migration_invariants import compare,verify_rollback,RehearsalViolation

def fixture():
    before={
        'users':[{'id':1,'role':'admin','active':True},{'id':2,'role':'user','active':True},{'id':3,'role':'user','active':False}],
        'profiles':[{'user_id':1},{'user_id':2},{'user_id':3}],
        'modules':[{'key':'1:scanner','user_id':1,'enabled':True,'version':1}],
        'connections':[{'id':'existing-private','owner_id':2,'mode':'user_owned','account_hash':'a'*64}],
        'history':[{'key':'history2','owner_id':2,'fingerprint':'b'*64}],
        'orders':[{'id':'existing-order','owner_id':1,'fingerprint':'c'*64}],
        'legacy_private':[{'key':'null-owner','owner_id':None,'ownership':'null'},{'key':'ambiguous-owner','owner_id':None,'ownership':'ambiguous'},{'key':'owned','owner_id':2,'ownership':'owned'}],
        'queued_work':[{'id':'old-work','owner_id':2,'compatible':False,'state':'pending'}],
    }
    after=deepcopy(before)
    after['users'].append({'id':4,'role':'user','active':True});after['profiles'].append({'user_id':4})
    for row in after['legacy_private']:
        if row['owner_id'] is None:row['ownership']='quarantined'
    after['queued_work'][0]['state']='cancelled'
    return before,after

class MigrationInvariants(unittest.TestCase):
    def test_unknown_roles_and_connection_modes_reject(self):
        for table, field, value in [('users','role','superadmin'),('connections','mode','shared_fallback')]:
            before,after=fixture();after[table][0][field]=value
            with self.subTest(table=table),self.assertRaises(RehearsalViolation):compare(before,after)

    def test_preservation_new_defaults_quarantine_and_counts(self):
        before,after=fixture();report=compare(before,after)
        self.assertEqual(report['new_accounts'],1)
        self.assertEqual(report['quarantined_private_rows'],2)
        self.assertEqual(report['history_counts_by_owner'],{2:1})
        self.assertFalse(report['database_execution_verified'])
        self.assertFalse(report['restore_verified'])

    def test_legacy_and_google_account_ids_roles_disabled_status_preserved(self):
        for field,value in [('id',8),('role','admin'),('active',True)]:
            before,after=fixture();after['users'][2][field]=value
            with self.subTest(field=field),self.assertRaises(RehearsalViolation):compare(before,after)

    def test_new_account_optional_module_or_admin_grant_rejected(self):
        for mutation in ('module','admin'):
            before,after=fixture()
            if mutation=='module':after['modules'].append({'key':'4:scanner','user_id':4,'enabled':True,'version':1})
            else:after['users'][-1]['role']='admin'
            with self.subTest(mutation=mutation),self.assertRaises(RehearsalViolation):compare(before,after)

    def test_foreign_connection_copy_history_move_or_order_approval_rejected(self):
        for table in ('connections','history','orders'):
            before,after=fixture();after[table][0]['owner_id']=4
            with self.subTest(table=table),self.assertRaises(RehearsalViolation):compare(before,after)

    def test_unresolved_ownership_never_assigned_to_logged_in_owner(self):
        before,after=fixture();after['legacy_private'][0].update(owner_id=1,ownership='owned')
        with self.assertRaises(RehearsalViolation):compare(before,after)

    def test_pending_incompatible_work_or_rebinding_rejected(self):
        for mutation in ('pending','owner'):
            before,after=fixture()
            after['queued_work'][0]['state']='pending' if mutation=='pending' else 'cancelled'
            if mutation=='owner':after['queued_work'][0]['owner_id']=1
            with self.subTest(mutation=mutation),self.assertRaises(RehearsalViolation):compare(before,after)

    def test_closed_projection_rejects_credentials_boolean_ids_and_orphans(self):
        for mutation in ('secret','boolean','orphan'):
            before,after=fixture()
            if mutation=='secret':after['connections'][0]['credential']='SYNTHETIC_MUST_NOT_EXPORT'
            elif mutation=='boolean':after['users'][0]['id']=True
            else:after['history'][0]['owner_id']=999
            with self.subTest(mutation=mutation),self.assertRaises(RehearsalViolation):compare(before,after)

    def test_repeated_initialization_snapshot_has_stable_per_owner_counts(self):
        _,after=fixture();result=compare(after,deepcopy(after))
        self.assertEqual(result['new_accounts'],0)
        self.assertEqual(result['module_counts_by_owner'],{1:1})
        self.assertEqual(result['connection_counts_by_owner'],{2:1})
        self.assertEqual(result['profile_counts_by_owner'],{1:1,2:1,3:1,4:1})
        self.assertEqual(result['orphan_count'],0)

    def test_failed_transaction_snapshot_must_roll_back_all_partial_changes(self):
        before,after=fixture();result=verify_rollback(before,deepcopy(before))
        self.assertFalse(result['database_execution_verified'])
        with self.assertRaises(RehearsalViolation):verify_rollback(before,after)
        partial=deepcopy(before);partial['connections'][0]['mode']='changed'
        with self.assertRaises(RehearsalViolation):verify_rollback(before,partial)

if __name__=='__main__':unittest.main()
