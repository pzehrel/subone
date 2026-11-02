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

## UI 基准

界面开发使用 `src/styles/theme.css` 中的全局样式变量。页面、面板、输入框、按钮和提示共用 `ui-*` 颜色与控件样式，新增界面不再单独定义同用途的颜色。

| 项目 | 基准 |
| --- | --- |
| 页面背景 | `--ui-page`，暖灰色 |
| 面板、弹窗标题栏和底部背景 | `--ui-surface`，白色 |
| 边框与分隔线 | `--ui-border`、`--ui-divider` |
| 主色与悬停色 | `--ui-accent`、`--ui-accent-hover` |
| 关闭按钮悬停背景 | `--ui-hover`，与白色标题栏区分 |
| 弹窗标题 | 14px，字重 600，行高 24px |
| 标题栏内边距 | 上下 16px，左右 20px |
| 内容内边距与字段间距 | 20px、16px |
| 底部操作区内边距 | 上下 12px，左右 20px |
| 弹窗与控件圆角 | 16px、12px |
| 关闭按钮 | 28px 点击区域，16px 图标 |
| 主次操作按钮 | 最小高度 32px，12px 文字 |
| 动画 | 打开 180ms，关闭和一般过渡 150ms；遵循减少动态效果设置 |

所有弹窗使用 `Modal`，通过 `ModalBody` 和 `ModalFooter` 划分内容与操作区；表单使用 `ModalForm`。标题栏与底部固定，只有内容区滚动。弹窗宽度通过 `size` 选择，文本编辑器使用 `layout="editor"` 和 `<ModalBody editor>`。

```tsx
<Modal open={open} title="添加订阅" onClose={() => setOpen(false)}>
  <ModalForm onSubmit={handleSubmit}>
    <ModalBody>
      {/* 表单字段 */}
    </ModalBody>
    <ModalFooter>
      <button type="button" className="ui-button-secondary" onClick={() => setOpen(false)}>
        取消
      </button>
      <button type="submit" className="ui-button-primary">
        保存
      </button>
    </ModalFooter>
  </ModalForm>
</Modal>
```

保持 `Modal` 挂载，用 `open` 控制显示，以保留关闭过渡。需要依赖非空数据的内容可以在内部条件渲染。嵌套弹窗共用页面滚动锁，Tab 焦点限制在最上层，关闭后恢复焦点；Esc 优先关闭提示，再关闭当前弹窗。字段帮助统一使用 `HelpTooltip`。

滚动区域使用 `overflow: auto`，保留浏览器与操作系统的原生滚动条。不定制滚动条宽高，不使用 `scrollbar-gutter: stable` 预留空间，也不隐藏原生滚动条。覆盖显示和自动隐藏跟随系统设置。
