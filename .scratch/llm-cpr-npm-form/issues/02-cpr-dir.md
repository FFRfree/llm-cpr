# 02 路径层默认 ~/.cpr

Status: ready-for-agent
Blocked by: 01

## 验收

- [ ] 运行时配置/数据默认目录改为 `~/.cpr`（`os.homedir()`，无平台分支）；`.env` 默认从 `~/.cpr/.env` 读；数据库默认 `~/.cpr/data.db`。
- [ ] `CPR_CONFIG_DIR`/`CPR_DATA_DIR`/`CPR_DB_FILE` 接缝保留，测试覆盖默认值与接缝两态。
- [ ] `node:sqlite` 不自建父目录：凡写库路径的入口（install/启动）先建目录。
- [ ] 测试：默认路径断言 + 接缝覆盖；旧接缝行为不破坏。

## Comments
