# Agent Note: SkillHub in Cowork

Status: proposed

English | [中文](2026-11-27-cowork-skillhub.zh.md)

## Problem

Cowork users need to discover and install SkillHub skills from the skills page.

## Proposal

Add a SkillHub tab beside Recommended for all users. Reuse the Recommended card grid and show separate industry and domain filter rows. Combine these with keyword search and server pagination. Read the service address from environment configuration.

Cowork requests the current skill by ID and version through the anonymous offline ZIP endpoint. The main process validates the manifest, archive limits and member digests before writing. Install missing dependencies before the requested skill. Preserve successful dependencies when a write fails, report the failed member, and skip already installed dependencies of the same version on retry. Detect local name conflicts before writing and preserve local skills.

Store SkillHub identity and installed version locally. Refresh My Installs after changes and indicate when the catalog version differs. SkillHub web and backend stay as deployed.

## Alternatives considered

The capability matrix was dropped in favor of two filter rows. An additional download confirmation and manual updates are outside the first release.

## Acceptance criteria

- AC1 — Signed-out users can open SkillHub, combine filters and search, and browse paginated cards (verification: renderer)
- AC2 — A missing service address shows a configuration message and request failures can be retried (verification: renderer)
- AC3 — A selected skill and missing dependencies install from the validated archive and appear in My Installs (verification: Electron)
- AC4 — Invalid packages and local name conflicts are rejected before writes, and a failed dependency stops target installation while a retry skips completed dependencies (verification: unit)
- AC5 — Installed and newer-version statuses reflect the local and catalog versions (verification: renderer)

## Risks

Archive content and limits must be checked independently in Cowork. HTTP transport is suitable only for trusted environments.
