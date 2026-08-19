# Threat Modeling Reference

Identify:
- assets worth protecting,
- actors,
- trust boundaries,
- entry points,
- privileged operations,
- data stores,
- third-party dependencies.

For each important flow ask:
- Can identity be forged?
- Can authorization be bypassed?
- Can data be modified or read across ownership boundaries?
- Can input trigger unintended interpreter/query behavior?
- Can repeated calls cause duplicate harm?
- Can failures expose sensitive internals?
- Can dependencies be abused to reach internal resources?
