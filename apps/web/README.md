# SubOne Web

SubOne 的 Web 控制台。安装与部署请参阅[项目 README](../../README.md)。

在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

控制台默认地址为 `http://localhost:5173`，API 默认地址为 `http://localhost:3456`。

```bash
pnpm --filter @subone/web typecheck
pnpm --filter @subone/web lint
pnpm --filter @subone/web build
```
