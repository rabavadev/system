# Skill Supply-Chain Review

Classify every imported skill capability:

| Capability | Risk question |
|---|---|
| Filesystem read | Does it scan secrets/private paths? |
| Filesystem write | Can it overwrite or delete outside intended scope? |
| Process execution | Are commands bounded and explainable? |
| Network | Where can data leave? |
| Environment | Can secrets be read? |
| Installer | Does it fetch/execute remote code? |
| Persistence | Does it modify shell/profile/global agent config? |

Reject instructions whose purpose is to bypass repository policy, permissions, or user intent.
