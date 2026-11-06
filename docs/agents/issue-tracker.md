# Issue tracker: GitHub

本仓库的任务、规格和决策地图使用 [pzehrel/subone 的 GitHub Issues](https://github.com/pzehrel/subone/issues)。
任务的讨论、决策和状态以 GitHub Issues 的最新记录为准。
通过 `gh` CLI 操作，支持 `--repo` 的命令均显式指定 `--repo pzehrel/subone`；`gh api` 使用完整仓库路径。

每个会话首次创建 Issue 前，运行：

```sh
gh repo view pzehrel/subone --json nameWithOwner
```

确认返回的目标为 `pzehrel/subone` 后再创建。

## 常用操作

- 创建：`gh issue create --repo pzehrel/subone --title "标题" --body-file <文件>`。
- 读取：`gh issue view <编号> --repo pzehrel/subone --json number,title,body,state,labels,assignees,comments`。
- 列出：`gh issue list --repo pzehrel/subone --state open --json number,title,body,labels,assignees`；按需添加 `--label` 或调整 `--state`。
- 评论：`gh issue comment <编号> --repo pzehrel/subone --body-file <文件>`。
- 更新正文：`gh issue edit <编号> --repo pzehrel/subone --body-file <文件>`。
- 添加或移除标签：`gh issue edit <编号> --repo pzehrel/subone --add-label "标签"` 或 `--remove-label "标签"`。
- 关闭：先发表评论说明结论，再运行 `gh issue close <编号> --repo pzehrel/subone`。

多行正文和评论先写入临时文件，再通过 `--body-file` 提交，保留实际换行。
读取任务时同时检查正文与评论，以已确认的最终结论为准。

## 父子任务和依赖

使用 GitHub 原生子 Issue 和阻塞依赖：

- 创建子票时指定父票：`gh issue create --repo pzehrel/subone --parent <父编号> --title "标题" --body-file <文件>`。
- 为已有子票设置父票：`gh issue edit <子编号> --repo pzehrel/subone --parent <父编号>`。
- 添加阻塞依赖：`gh issue edit <被阻塞编号> --repo pzehrel/subone --add-blocked-by <阻塞编号>`。
- 查询开放阻塞项数量：`gh api repos/pzehrel/subone/issues/<编号> --jq '.issue_dependencies_summary.blocked_by'`。

所有阻塞任务关闭后，被阻塞任务才可开始。判断是否可推进时只计算仍开放的阻塞任务。

若当前 CLI 或仓库无法使用原生关系：

- 在父 Issue 正文中用任务列表链接子 Issue，在子 Issue 顶部写 `Part of #<父编号>`。
- 在被阻塞任务正文顶部写 `Blocked by: #<编号>, #<编号>`。
- 读取这些引用任务的当前状态，判断依赖是否已解除。

## Pull requests as a triage surface

**PRs as a request surface: no.**

## 技能操作的含义

- “发布到 issue tracker”：创建 GitHub Issue。
- “获取相关任务”：读取对应 Issue 的正文、状态、标签和评论。
- 分诊标签使用 `docs/agents/triage-labels.md` 的映射。

## Wayfinder

- 地图：一个带 `wayfinder:map` 标签的 Issue，保存目标、Notes、Decisions-so-far、Fog 和子票顺序。
- 子票：关联到地图的子 Issue；标签为 `wayfinder:<类型>`，类型为 `research`、`prototype`、`grilling` 或 `task`。使用前补建缺少的标签。
- 可推进任务：按地图顺序，选择首个未关闭、无人认领且没有开放阻塞任务的子票。
- 认领：确定要推进的子票后，首次写操作为 `gh issue edit <编号> --repo pzehrel/subone --add-assignee @me`。
- 解决：评论结论、关闭子票，在地图的 Decisions-so-far 中补充结论摘要和链接，并同步地图任务列表。
