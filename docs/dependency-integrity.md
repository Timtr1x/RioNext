# P0 dependency pin

Node: 24.12.0 (engines >=22.19.0)
Pi source commit: 3fc3ef532b966b28b764af070d62302c0acab0d5
Declared package version: 0.84.4

npm integrity (package-lock.json):

- @earendil-works/pi-agent-core@0.84.4 sha512-HyUnjaOXj6oN/6SNcr8A1J/ElRQA50FtIE0XUTSKAQVqmdlb9qdojOyUQwF/jULE5+yOEtGuVgi/N1RnBiNG+g==
- @earendil-works/pi-ai@0.84.4 sha512-AClAZxf5+c4RRu44NJPS6wyQy+Nmq+Mzyyrdvm4ZVMNuixelO02RZX4G4Aq1F145Yzp43wnM5S+hLlSI7ypfVw==
- typebox@1.3.7 sha512-meKuifc33Pccx0O6PdIzYMq3Og8zvP4TIi/a+Bw3AEMZMxOD0+RHGQvpglEe6Zdy3wZ8nqn/j95h8LUZLk/6Hg==

SQLite: Node.js `node:sqlite` (bundled SQLite 3.50.4). Durability: WAL + synchronous=NORMAL. Process crash on a working volume keeps committed rows; this is not a power-loss guarantee on every disk. Active WAL must not be backed up by copying only the main DB file.

Controller uses `Agent` from pi-agent-core with injected `streamFn`. It does not use the coding-agent SDK/CLI as the campaign controller. `toolExecution` is sequential.
