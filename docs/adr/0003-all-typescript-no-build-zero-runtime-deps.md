# 全仓 TypeScript、类型擦除直跑、零运行时依赖

`core/`、`test/`、`scripts/` 只有 `.ts`，Node ≥ 22.18 原生类型擦除直接运行：无构建步骤、`import` 必须带 `.ts` 后缀、`npm run typecheck` 是唯一静态门、编译期负例独立在 `type-tests/`（`node --test` 会执行 `test/` 目录下所有文件，类型测试必须留在该目录之外）。取舍：换来「clone 即跑」和发布即源码（源码里的类型就是用户拿到手的类型，不存在 .d.ts 漂移）；代价是锁死 Node 版本下限、放弃编译产物带来的体积/混淆优势。
