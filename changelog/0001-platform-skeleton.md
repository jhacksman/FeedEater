## 0001 - Initial platform skeleton

- Added monorepo scaffolding (web/api/worker + core/db packages)
- Added NATS JetStream + Redis (BullMQ) + Postgres compose runtime behind Caddy proxy (port 666)
- Added BullBoard mounted at `/bullboard` and embedded in the web UI via iframe
- Added encrypted-at-rest settings registry backed by Postgres (Prisma)
- Added `modules/example` as a reference module (scheduled + event-triggered job)
- Added Make/Ansible deployment scaffolding


