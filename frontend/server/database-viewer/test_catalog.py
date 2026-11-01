import ast
import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).parent
REPO = HERE.parents[2]
spec = importlib.util.spec_from_file_location('viewer_plan_sql', HERE / 'plan_sql.py')
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


class CatalogTests(unittest.TestCase):
    def test_every_projected_and_policy_column_exists_in_source_model(self):
        for item in plan.catalog()['relations']:
            module = ast.parse((REPO / item['source_path']).read_text())
            model = next(node for node in module.body if isinstance(node, ast.ClassDef) and node.name == item['source_model'])
            columns = {node.target.id for node in model.body if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)}
            self.assertTrue(any(isinstance(base, ast.Name) and base.id=='TimestampMixin' for base in model.bases))
            columns |= {'created_at', 'updated_at'}  # inspected TimestampMixin
            self.assertTrue(set(item['columns'] + item['policy_columns']) <= columns, item['relation'])
            self.assertIn('id', columns)
            primary = next(node for node in model.body if isinstance(node, ast.AnnAssign) and getattr(node.target,'id',None)=='id')
            self.assertTrue(any(keyword.arg=='primary_key' and isinstance(keyword.value, ast.Constant) and keyword.value.value is True for keyword in primary.value.keywords))

    def test_sensitive_relations_and_payload_columns_are_excluded(self):
        excluded = {'users', 'user_sessions', 'api_keys', 'zerodha_credentials', 'google_sheets_credentials'}
        forbidden = {'user_id', 'prompt', 'prompt_preview', 'body', 'description', 'response', 'error_message', 'raw_text', 'summary_json', 'request_context_json', 'runtime_metadata_json', 'exported_sheet_url', 'provider_request_id'}
        for item in plan.catalog()['relations']:
            self.assertNotIn(item['relation'], excluded)
            self.assertFalse(set(item['columns']) & forbidden)
            self.assertFalse(any(c.endswith('_json') for c in item['columns']))

    def test_owner_and_crosslink_predicates_are_explicit(self):
        items = {i['relation']: i for i in plan.catalog()['relations']}
        for item in items.values():
            self.assertIn('{owner_id}', item['ownership'])
        self.assertIn('r.user_id = {owner_id}', items['run_jobs']['ownership'])
        self.assertIn('j.user_id = {owner_id}', items['run_jobs']['ownership'])
        self.assertIn('w.user_id = {owner_id}', items['auto_rebalance_workflow_stages']['ownership'])
        self.assertIn('t.is_system = false', items['prompts']['ownership'])

    def test_template_is_nonexecuting_view_only_plan_with_no_broad_select(self):
        sql = plan.review_sql()
        self.assertEqual(sql, (HERE / '001-owner-views.review.sql').read_text())
        self.assertIn('__PRIVATE_VERIFIED_OWNER_ID__', sql)
        self.assertIn('security_barrier=true', sql)
        self.assertIn('END;\n$audit$;', sql)
        self.assertIn('aclexplode', sql)
        self.assertIn('views_owner', sql)
        self.assertEqual(plan.audit_sql(), (HERE/'privilege-audit.review.sql').read_text())
        self.assertNotIn('security_invoker', sql)
        self.assertNotIn('GRANT SELECT ON ALL', sql)
        self.assertNotIn('SELECT *', sql)
        self.assertNotIn('COMMIT;', sql)
        self.assertTrue(sql.endswith('ROLLBACK; -- review template never commits\n'))


if __name__ == '__main__':
    unittest.main()
