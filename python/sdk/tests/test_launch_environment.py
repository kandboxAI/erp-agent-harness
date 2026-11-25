import json
import sys
from pathlib import Path

from deepseek_harness import HarnessClient, HarnessConfig


def test_explicit_environment_does_not_inherit_parent_secrets(tmp_path: Path, monkeypatch):
    output = tmp_path / "child-env.json"
    script = tmp_path / "environment.py"
    script.write_text("import os,json\njson.dump(dict(os.environ), open(os.environ['OUT'], 'w'))\n", encoding="utf-8")
    monkeypatch.setenv("UNRELATED_DATABASE_PASSWORD", "must-not-inherit")
    client = HarnessClient(HarnessConfig(inherit_env=False, env={"OUT": str(output)}), _launch_args=(sys.executable, str(script)))
    client.start()
    client._proc.wait(timeout=5)
    child_env = json.loads(output.read_text())
    assert "UNRELATED_DATABASE_PASSWORD" not in child_env
    assert child_env["OUT"] == str(output)
    client.close()


def test_source_cli_launches_node_with_profile_arguments(tmp_path: Path):
    entry = tmp_path / "apps/cli/src/bin.ts"
    client = HarnessClient(HarnessConfig(dsh_bin=str(entry), node_bin="node-test", profile="sdk-minimal", dsh_home=str(tmp_path)))
    args = client._default_launch_args({})
    assert args == ("node-test", "--import", "tsx/esm", str(entry.resolve()), "--profile", "sdk-minimal")
