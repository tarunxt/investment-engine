"""Mock only the Alembic entry function; never invoke a local migration."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock,Mock


class MigrationConnection(unittest.TestCase):
    def function(self,connection):
        source=Path(__file__).resolve().parents[3]/'backend/alembic/env.py'
        node=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='run_migrations_online')
        context=MagicMock();engine=MagicMock();url=Mock(return_value='postgresql://synthetic.invalid/unused')
        namespace={'config':SimpleNamespace(attributes={} if connection is None else {'connection':connection},config_ini_section='alembic',get_section=Mock(return_value={})),
                   'context':context,'target_metadata':object(),'get_database_url':url,'engine_from_config':engine,'pool':SimpleNamespace(NullPool=object())}
        exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),namespace)
        return namespace,context,engine,url

    def test_supplied_active_transaction_uses_same_connection_without_new_engine(self):
        connection=Mock();connection.in_transaction.return_value=True
        ns,context,engine,url=self.function(connection);ns['run_migrations_online']()
        context.configure.assert_called_once_with(connection=connection,target_metadata=ns['target_metadata'])
        context.run_migrations.assert_called_once();engine.assert_not_called();url.assert_not_called()

    def test_supplied_inactive_connection_cannot_run_or_open_another_route(self):
        connection=Mock();connection.in_transaction.return_value=False
        ns,context,engine,url=self.function(connection)
        with self.assertRaisesRegex(RuntimeError,'active transaction'):ns['run_migrations_online']()
        context.run_migrations.assert_not_called();engine.assert_not_called();url.assert_not_called()

    def test_ordinary_cli_connection_path_is_preserved(self):
        ns,context,engine,url=self.function(None);ns['run_migrations_online']()
        engine.assert_called_once_with({'sqlalchemy.url':url.return_value},prefix='sqlalchemy.',poolclass=ns['pool'].NullPool)
        connection=engine.return_value.connect.return_value.__enter__.return_value
        context.configure.assert_called_once_with(connection=connection,target_metadata=ns['target_metadata'])
        context.run_migrations.assert_called_once()
