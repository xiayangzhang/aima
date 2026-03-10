# Quickstart: AIMA Core — Workspace & Schema

## 前置条件

- Bun v1.x（`curl -fsSL https://bun.sh/install | bash`）
- PostgreSQL 16+（本地或 Docker）
- 两个 `.env` 文件（开发 + 测试）

## 本地 PostgreSQL（Docker 快速启动）

```bash
docker run -d \
  --name aima-postgres \
  -e POSTGRES_USER=aima \
  -e POSTGRES_PASSWORD=aima \
  -e POSTGRES_DB=aima_dev \
  -p 5432:5432 \
  postgres:16
```

测试数据库（独立，避免开发数据污染）：

```bash
docker exec aima-postgres \
  psql -U aima -c "CREATE DATABASE aima_test;"
```

## 环境变量

```bash
# .env（开发）
DATABASE_URL=postgres://aima:aima@localhost:5432/aima_dev

# .env.test（集成测试）
AIMA_TEST_DATABASE_URL=postgres://aima:aima@localhost:5432/aima_test
```

## 安装依赖

```bash
bun install
```

## 运行 Migration

```bash
# 生成迁移文件（schema 变更后执行）
bun run db:generate

# 应用迁移
bun run db:migrate
```

## 运行测试

```bash
# 单元测试（无 DB，bun test）
bun test

# 集成测试（需要 PostgreSQL）
bun run test:integration

# 全部
bun run test:all
```

## 构建

```bash
# 构建 dist/（ESM + CJS）
bun run build

# 类型检查
bun run typecheck
```

## 常用 Scripts（package.json）

| Script | 命令 |
|---|---|
| `db:generate` | `drizzle-kit generate` |
| `db:migrate` | `drizzle-kit migrate` |
| `db:studio` | `drizzle-kit studio`（可视化查看数据） |
| `test` | `bun test` |
| `test:integration` | `vitest run --config vitest.integration.config.ts` |
| `test:all` | `bun test && vitest run` |
| `build` | `tsup` |
| `typecheck` | `tsc --noEmit` |
| `lint` | `biome check .` |
| `lint:fix` | `biome check --write .` |
