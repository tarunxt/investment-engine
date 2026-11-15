import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("artifact",Path(__file__).with_name("backend-recovery-artifact.py"))
artifact=importlib.util.module_from_spec(spec);spec.loader.exec_module(artifact)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.backend=self.root/"backend";self.backup=self.root/"release"
        for name in ("app/nested","scripts","alembic/versions",".venv"):
            (self.backend/name).mkdir(parents=True)
        self.files={"app/main.py":"previous","app/nested/guard.py":"contained","scripts/tool.py":"old-tool","alembic/versions/old.py":"old-migration","requirements.txt":"same-dependencies"}
        for name,content in self.files.items(): (self.backend/name).write_text(content)
        (self.backend/".env").write_text("untouched-fixture")
        (self.backend/".venv/runtime").write_text("untouched-runtime")
        (self.root/"deploy/no-docker/scripts").mkdir(parents=True)
        (self.root/"deploy/no-docker/scripts/run-backend.sh").write_text("previous-launcher")
        self.tracked={"backend/"+name for name in self.files}|{"deploy/no-docker/scripts/run-backend.sh"}
        manifest_patch=patch.object(artifact,"tracked_sources",side_effect=lambda _:self.tracked)
        manifest_patch.start();self.addCleanup(manifest_patch.stop)

    def test_complete_restore_recovers_deleted_source_and_removes_candidate_additions(self):
        artifact.snapshot(self.root,self.backup,"a"*40)
        (self.backend/"app/main.py").write_text("new")
        (self.backend/"app/nested/guard.py").unlink()
        (self.backend/"app/new_feature.py").write_text("candidate-only")
        (self.backend/"candidate.py").write_text("candidate-root")
        self.tracked|={"backend/candidate.py","backend/app/new_feature.py"}
        self.tracked.discard("backend/app/nested/guard.py")
        (self.root/"deploy/no-docker/scripts/run-backend.sh").write_text("candidate-launcher")
        restored=artifact.restore(self.root,self.backup)
        self.assertEqual(restored["previous_sha"],"a"*40)
        for name,content in self.files.items(): self.assertEqual((self.backend/name).read_text(),content)
        self.assertFalse((self.backend/"app/new_feature.py").exists())
        self.assertFalse((self.backend/"candidate.py").exists())
        self.assertEqual((self.backend/".env").read_text(),"untouched-fixture")
        self.assertEqual((self.backend/".venv/runtime").read_text(),"untouched-runtime")
        self.assertEqual((self.root/"deploy/no-docker/scripts/run-backend.sh").read_text(),"previous-launcher")
        self.assertTrue(list(self.backup.glob("failed-candidate-*/backend/app/new_feature.py")))

    def test_corrupt_archive_cannot_change_live_code(self):
        artifact.snapshot(self.root,self.backup,"a"*40)
        with (self.backup/"backend-source.tar.gz").open("ab") as target: target.write(b"corrupt")
        with self.assertRaisesRegex(ValueError,"checksum"): artifact.restore(self.root,self.backup)
        self.assertEqual((self.backend/"app/main.py").read_text(),"previous")

    def test_missing_still_tracked_candidate_files_do_not_block_restore(self):
        artifact.snapshot(self.root,self.backup,"a"*40)
        (self.backend/"app/main.py").unlink()
        (self.backend/"requirements.txt").unlink()
        with self.assertRaisesRegex(ValueError,"complete snapshot blocked"):
            artifact.snapshot(self.root,self.root/"incomplete-release","a"*40)
        artifact.restore(self.root,self.backup)
        self.assertEqual((self.backend/"app/main.py").read_text(),"previous")
        self.assertEqual((self.backend/"requirements.txt").read_text(),"same-dependencies")

    def test_broken_candidate_symlink_blocks_restore_before_replacement(self):
        artifact.snapshot(self.root,self.backup,"a"*40)
        (self.backend/"app/main.py").unlink()
        (self.backend/"app/main.py").symlink_to(self.backend/"missing.py")
        with self.assertRaisesRegex(ValueError,"symlink"):
            artifact.restore(self.root,self.backup)
        self.assertTrue((self.backend/"app/main.py").is_symlink())

    def test_symlink_or_nested_credential_blocks_before_snapshot(self):
        (self.backend/"app/link.py").symlink_to(self.backend/".env")
        with self.assertRaisesRegex(ValueError,"symlink"): artifact.snapshot(self.root,self.backup,"a"*40)
        self.assertFalse(self.backup.exists())
        (self.backend/"app/link.py").unlink();(self.backend/"app/.env").write_text("fixture")
        with self.assertRaisesRegex(ValueError,"Credential-like"): artifact.snapshot(self.root,self.backup,"a"*40)
        self.assertFalse(self.backup.exists())

    def test_untracked_root_json_is_never_read_or_restored_and_nested_data_blocks(self):
        root_data=self.backend/"service-account.json";root_data.write_text("runtime-sentinel")
        saved=artifact.snapshot(self.root,self.backup,"a"*40)
        self.assertNotIn("backend/service-account.json",saved["files"])
        root_data.write_text("concurrent-runtime-sentinel")
        artifact.restore(self.root,self.backup)
        self.assertEqual(root_data.read_text(),"concurrent-runtime-sentinel")
        (self.backend/"app/runtime-history.json").write_text("runtime-data")
        with patch.object(Path,"read_bytes",side_effect=AssertionError("Unexpected data read")):
            with self.assertRaisesRegex(ValueError,"Untracked"):
                artifact.snapshot(self.root,self.root/"second-release","a"*40)


if __name__=="__main__": unittest.main()
