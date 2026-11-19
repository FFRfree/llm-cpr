# 02 路径层默认 ~/.cpr

Status: completed
Blocked by: 01

## 验收

- [x] 运行时配置/数据默认目录改为 `~/.cpr`（`os.homedir()`，无平台分支）；`.env` 默认从 `~/.cpr/.env` 读；数据库默认 `~/.cpr/data.db`。
- [x] `CPR_CONFIG_DIR`/`CPR_DATA_DIR`/`CPR_DB_FILE` 接缝保留，测试覆盖默认值与接缝两态。
- [x] `node:sqlite` 不自建父目录：引擎开库前 `mkdirSync(recursive)`，install 预建不变。
- [x] 测试：默认路径断言 + 接缝覆盖；旧接缝行为不破坏。

## Comments

- commit 3ec12a9：`core/paths.ts` 单一事实源（configDir/dataDir/defaultDbPath/envFile）+ `core/envfile.ts` 零依赖 .env 加载器（只填缺失键、剥配对引号、容忍非法行）+ `main.ts` 启动时自加载 .env（CPR_ENV_FILE 接缝优先）+ `server.ts` DB 兜底废「代码目录上两层」改 `defaultDbPath(env)` 且开库前建父目录 + `cpr.ts` 两默认值并列同步（CLI 保持自包含零依赖）。
- 验证：`npm run typecheck` 0 错；`node --test` 140/140（新增 test/paths.test.ts 4 例：默认落点/HOME 接缝/envfile 语义/引擎 DB 兜底落点与父目录自动建）；bootMain 补钉 `CPR_CONFIG_DIR` 到 tmp 保 hermetic。
- 没做的验证：本机生产未动（unit 显式 `CPR_DB_FILE` 指旧路径，不受默认值变化影响）。
