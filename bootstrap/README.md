# Bootstrap

After copying the pack into a repository root:

```bash
python bootstrap/install_agent_pack.py --agent all
```

The installer creates **thin managed pointers**, not copies of the full policy.

It will not overwrite an existing unmanaged Claude/Cursor/Copilot instruction file unless `--force` is supplied.

Zed can use the root `AGENTS.md` directly, so the installer intentionally avoids creating another competing project-rule file for it.
