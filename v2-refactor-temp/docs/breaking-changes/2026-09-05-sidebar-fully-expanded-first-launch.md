---
title: Sidebar opens fully expanded on first launch
category: changed
severity: notice
introduced_in_pr: "TBD"
date: 2026-09-05
---

## What changed

The default left-sidebar width for genuinely unconfigured users is now 280px (fully expanded, full layout) instead of 50px (icon-only strip). Users who have already dragged or resized the sidebar keep their persisted width after updating.

## Why this matters to the user

A brand-new install opens with the sidebar showing the full layout — navigation labels, search, and history sections — instead of the compact icon rail. The sidebar can still be dragged to the icon width or hidden, and any such change persists as before.

## What the user should do

Nothing — automatic. Existing installs keep their saved sidebar width; only first launch uses the new default.

## Notes for release manager

This changes only the `ui.sidebar.width` default in the renderer persist-cache schema. Existing persisted values are loaded over defaults, so no migration or seeding change is involved.
