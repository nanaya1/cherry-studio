---
title: Default assistant names no longer include "Cherry"
category: changed
severity: notice
introduced_in_pr: #TBD
date: 2026-09-05
---

## What changed

The Chinese display names of the built-in assistants were renamed: the seeded default assistant is now `默认助手` (was `Cherry 助手`) and the builtin Cherry Assistant agent is now `默认小助手` (was `Cherry 小助手`).

## Why this matters to the user

Fresh profiles with a Chinese system language, and users who switch the app language to Chinese before first use, will see the new names in the assistant list and agent library. Existing installations keep the names already persisted in their database — the rename does not overwrite user data.

## What the user should do

Nothing — automatic. Rename manually if the old name is preferred.
