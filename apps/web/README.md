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

页面、弹窗内容区和表格滚动区域使用 `overflow: auto`，保留浏览器与操作系统的原生滚动条。不定制滚动条宽高，不使用 `scrollbar-gutter: stable` 预留空间，也不隐藏原生滚动条。覆盖显示和自动隐藏跟随系统设置。

### 表单控件

表单与筛选栏使用 `components/ui` 中的 `Input`、`Textarea`、`Select`、`Field` 和 `Label`，不再直接绘制原生选择器或单独定义表单外观。

- 默认控件高度 36px；表格内使用 `controlSize="sm"`，高度 30px。
- 控件左右内边距 12px；选择器箭头有独立位置和 12px 留白，长选项名称在触发器中省略。
- `Field` 自动关联标签与控件；`hint`、`error` 自动关联说明、错误消息和无障碍状态。
- `Input` 保留原生的必填、只读、禁用、表单提交与重置行为；`type="checkbox"` 和 `type="radio"` 使用同一套选择状态样式。
- `Textarea` 默认可纵向调整高度；配置编辑器使用 `variant="code"`，调用处只控制布局与行数。
- `Select` 使用自定义选项列表，值通过 `onValueChange` 更新，支持空值、禁用项、键盘导航、打字定位和关闭过渡。
- 选择器列表在当前弹窗层中浮动，超出可视区域时自动避让；Esc 先关闭列表。设置 `name`、`required` 时，保留原生表单数据与必填校验行为。

```tsx
<Field hint="选择订阅内容的格式">
  <Label>格式解析模式</Label>
  <Select value={format} onValueChange={setFormat}>
    <SelectItem value="auto">自动识别</SelectItem>
    <SelectItem value="clash">Clash YAML</SelectItem>
  </Select>
</Field>
```

### 表格和徽章

表格使用 `Table`、`TableHead`、`TableCell`，徽章使用 `Badge`。默认采用内容驱动的自动列宽，不给每列规定固定宽度。

- 表头和徽章始终单行，操作按钮也保持一行。
- 可省略列宽约束；长内容列可以通过 `TableCell` 的 `minWidth`、`maxWidth` 限定范围，通过 `truncate` 选择省略展示。
- 受限内容列先压缩到允许的最小宽度；空间仍不足时，表格区域横向滚动，不挤压表头、徽章或整个页面。
- 表头统一为 11px、字重 600、10px × 16px 内边距；单元格使用 12px 文字、12px × 16px 内边距。
- `Badge` 统一为 10px 文字、18px 行高，通过 `tone` 选择中性、强调、成功、错误、警告、信息或反色样式。
- 列内选择器复用同一个 `Select`，只切换为紧凑尺寸，列表不会被表格滚动容器裁切。
- 固定列在对应的 `TableHead` 和 `TableCell` 上同时设置 `fixed="left"` 或 `fixed="right"`；操作列统一使用 `fixed="right"`。
- 多个固定列按实际宽度自动累计偏移，容器大小或内容宽度变化时重新排列，不需要设置固定列宽。
- 固定列使用不透明背景并跟随行悬停状态；横向滚动存在遮挡时显示边界阴影。

```tsx
<Table label="分流规则">
  <thead>
    <tr>
      <TableHead>规则名称</TableHead>
      <TableHead>类型</TableHead>
      <TableHead fixed="right" className="text-right">操作</TableHead>
    </tr>
  </thead>
  <tbody>
    <tr>
      <TableCell minWidth={160} maxWidth={260} truncate title={rule.name}>
        {rule.name}
      </TableCell>
      <TableCell><Badge>{rule.type}</Badge></TableCell>
      <TableCell fixed="right" className="text-right">
        <div className="ui-table-actions">
          <button type="button" onClick={() => openEditModal(rule)}>编辑</button>
        </div>
      </TableCell>
    </tr>
  </tbody>
</Table>
```
