---
title: Default assistant names renamed to 工匠助手 / 工匠智能体
category: changed
severity: notice
introduced_in_pr: #TBD
date: 2026-09-05
---

## What changed

The Chinese display names of the built-in assistants were renamed: the seeded default assistant is now `工匠助手` (was `Cherry 助手`, then `默认助手`) and the builtin Cherry Assistant agent is now `工匠智能体` (was `Cherry 小助手`, then `默认小助手`).

## Why this matters to the user

Fresh profiles with a Chinese system language, and users who switch the app language to Chinese before first use, will see the new names in the assistant list and agent library. On the next launch after upgrading, existing installations whose builtin entries still carry one of the prior stock names are renamed automatically; user-chosen names and the English default are left untouched.

## What the user should do

Nothing — automatic. Rename manually if the old name is preferred.
