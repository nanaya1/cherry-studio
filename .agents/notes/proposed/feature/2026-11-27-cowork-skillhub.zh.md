# Agent Note: 在 Cowork 接入 SkillHub

Status: proposed

[English](2026-11-27-cowork-skillhub.md) | 中文

## 问题

Cowork 用户需要在技能页浏览和安装 SkillHub 技能。

## 提案

为所有用户在「推荐」旁增加 SkillHub Tab，沿用推荐页卡片网格。行业与专业域各用一排筛选项，与关键词搜索及服务端分页组合使用。服务地址从环境配置读取。

Cowork 使用技能标识和当前版本请求匿名离线 ZIP。主进程在写入前校验清单、归档限制和包摘要。先安装缺失依赖，再安装目标技能。写入失败时保留已经装好的依赖并提示失败项，重试时跳过已安装的同版本依赖。写入前检测本地同名冲突并保留本地技能。

在本地记录 SkillHub 技能标识和已装版本。安装变化后刷新「我的安装」，目录有新版时显示提示。SkillHub 网页和后端继续使用现有部署。

## 考虑过的替代方案

采用两排筛选项，取消能力矩阵。首版省略额外的安装确认以及手动更新功能。

## 验收标准

- AC1 — 未登录用户可打开 SkillHub，组合筛选和搜索并分页浏览卡片 (verification: renderer)
- AC2 — 缺少服务地址时提示配置，请求失败时可以重试 (verification: renderer)
- AC3 — 目标技能和缺失依赖从校验后的归档中安装，并出现在「我的安装」 (verification: Electron)
- AC4 — 无效包和本地同名冲突在写入前拒绝，依赖失败时停止安装目标，重试时跳过已装依赖 (verification: unit)
- AC5 — 根据本地版本和目录版本显示已安装与新版提示 (verification: renderer)

## 风险

Cowork 需要独立检查归档内容和上限。HTTP 仅适用于受信任的环境。
