"""Only the two observed PG16 decompilations normalize; drift stays visible."""
import copy,json,unittest
import schema_service as helper

class StateFingerprint(unittest.TestCase):
    def check(self,expression,*,table='confirmed_order_intents',name='ck_confirmed_order_state',**extra):
        row={'name':name,'sqltext':expression,**extra};return helper.canonical_checks(table,[row])[0]
    def test_exact_observed_forms_equal_without_mutating_source(self):
        a,b=helper.ORDER_STATE_CHECK_FORMS;original={'name':'ck_confirmed_order_state','sqltext':b,'comment':'retained'};saved=copy.deepcopy(original)
        self.assertEqual(helper.canonical_checks('confirmed_order_intents',[original]),[{'name':'ck_confirmed_order_state','sqltext':a,'comment':'retained'}]);self.assertEqual(original,saved)
        self.assertEqual(self.check(a),self.check(b))
    def test_other_table_or_constraint_never_normalizes(self):
        b=helper.ORDER_STATE_CHECK_FORMS[1]
        for table,name in [('other','ck_confirmed_order_state'),('confirmed_order_intents','other'),('confirmed_order_legs','ck_confirmed_order_state')]:
            with self.subTest(table=table,name=name):self.assertEqual(self.check(b,table=table,name=name)['sqltext'],b)
    def test_every_state_removal_change_and_addition_stays_distinct(self):
        canonical=self.check(helper.ORDER_STATE_CHECK_FORMS[0])
        for expression in helper.ORDER_STATE_CHECK_FORMS:
            for state in ['draft','validated','awaiting_approval','approved','submitting','acknowledged','unknown','partial','filled','rejected','cancelled','invalidated']:
                for mutation in [expression.replace("'"+state+"'","'other_"+state+"'"),expression.replace("'"+state+"'::character varying, ",''),expression.replace("'"+state+"'::character varying::text, ",'')]:
                    if mutation==expression:continue
                    with self.subTest(state=state,expression=expression,mutation=mutation):self.assertNotEqual(self.check(mutation),canonical)
            self.assertNotEqual(self.check(expression.replace("'draft'","'new'::text, 'draft'")),canonical)
    def test_column_operator_domain_and_cast_drift_not_erased(self):
        canonical=self.check(helper.ORDER_STATE_CHECK_FORMS[0])
        for expression in helper.ORDER_STATE_CHECK_FORMS:
            for mutation in [expression.replace('state::text','other::text'),expression.replace(' = ANY',' <> ALL'),expression.replace('character varying','integer'),expression.replace('text','citext'),expression+' OR true',expression.replace("'filled'","'FILLED'")]:
                with self.subTest(mutation=mutation):self.assertNotEqual(self.check(mutation),canonical)
    def test_metadata_and_unrelated_checks_remain_fingerprint_material(self):
        a,b=helper.ORDER_STATE_CHECK_FORMS
        self.assertNotEqual(self.check(a,comment='changed'),self.check(b,comment='original'))
        checks=[{'name':'other','sqltext':'quantity > 0'},{'name':'ck_confirmed_order_state','sqltext':b}]
        result=helper.canonical_checks('confirmed_order_intents',checks)
        self.assertEqual(result[0],checks[0]);self.assertEqual(result[1]['sqltext'],a)
    def test_legacy_connection_domain_behavior_unchanged(self):
        a,b=helper.MODE_CHECK_FORMS
        self.assertEqual(helper.canonical_checks('integration_connections',[{'name':'ck_connection_mode','sqltext':a}]),helper.canonical_checks('integration_connections',[{'name':'ck_connection_mode','sqltext':b}]))
        self.assertEqual(self.check(b)['sqltext'],b)
