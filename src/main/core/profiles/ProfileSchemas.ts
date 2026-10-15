import * as z from 'zod'

const isoDateTimeSchema = z.iso.datetime()
const profileIdSchema = z.union([z.literal('signed-out'), z.string().regex(/^[a-f0-9]{32}$/)])
const identityDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const InstallationRecordV1Schema = z.strictObject({
  version: z.literal(1),
  deviceInstallId: z.uuid(),
  createdAt: isoDateTimeSchema
})

const ProfileDisplayV1Schema = z.strictObject({
  label: z.string().optional()
})

const ProfileAuthorizationContextV1Schema = z.strictObject({
  groupId: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
  checkedAt: isoDateTimeSchema.optional()
})

export const ProfileRecordV1Schema = z.strictObject({
  version: z.literal(1),
  profileId: profileIdSchema,
  identityDigest: identityDigestSchema,
  kind: z.enum(['signed-out', 'local', 'authenticated']),
  state: z.enum(['ready', 'disabled']),
  createdAt: isoDateTimeSchema,
  display: ProfileDisplayV1Schema.optional(),
  authorizationContext: ProfileAuthorizationContextV1Schema.optional()
})

export const ProfileRegistryV1Schema = z.strictObject({
  version: z.literal(1),
  profiles: z.array(ProfileRecordV1Schema)
})

export const ActiveProfilePointerV1Schema = z.strictObject({
  version: z.literal(1),
  profileId: profileIdSchema,
  identityDigest: identityDigestSchema,
  committedAt: isoDateTimeSchema,
  operationId: z.uuid().optional()
})

const ProfileSwitchJournalBaseV1Shape = {
  version: z.literal(1),
  operationId: z.uuid(),
  fromProfileId: profileIdSchema,
  targetProfileId: profileIdSchema,
  targetIdentityDigest: identityDigestSchema,
  createdAt: isoDateTimeSchema
}

const PreparedProfileSwitchJournalV1Schema = z.strictObject({
  ...ProfileSwitchJournalBaseV1Shape,
  phase: z.literal('prepared')
})

const CommittedProfileSwitchJournalV1Schema = z.strictObject({
  ...ProfileSwitchJournalBaseV1Shape,
  phase: z.literal('committed'),
  committedAt: isoDateTimeSchema
})

export const ProfileSwitchJournalV1Schema = z.discriminatedUnion('phase', [
  PreparedProfileSwitchJournalV1Schema,
  CommittedProfileSwitchJournalV1Schema
])

const LegacyAdoptionJournalBaseV1Shape = {
  version: z.literal(1),
  operationId: z.uuid(),
  legacyRoot: z.string(),
  stagingRoot: z.string()
}

const LegacyAdoptionCopyingJournalV1Schema = z.strictObject({
  ...LegacyAdoptionJournalBaseV1Shape,
  phase: z.literal('copying')
})

const LegacyAdoptionStagedJournalV1Shape = {
  ...LegacyAdoptionJournalBaseV1Shape,
  profileId: profileIdSchema,
  identityDigest: identityDigestSchema,
  targetRoot: z.string()
}

const LegacyAdoptionStagedJournalV1Schema = z.strictObject({
  ...LegacyAdoptionStagedJournalV1Shape,
  phase: z.literal('staged')
})

const LegacyAdoptionCommittedJournalV1Schema = z.strictObject({
  ...LegacyAdoptionStagedJournalV1Shape,
  phase: z.literal('committed'),
  committedAt: isoDateTimeSchema
})

export const LegacyAdoptionJournalV1Schema = z.discriminatedUnion('phase', [
  LegacyAdoptionCopyingJournalV1Schema,
  LegacyAdoptionStagedJournalV1Schema,
  LegacyAdoptionCommittedJournalV1Schema
])

const ProfileClaimJournalBaseV1Shape = {
  version: z.literal(1),
  operationId: z.uuid(),
  previewId: z.uuid(),
  sourceRoot: z.string(),
  targetRoot: z.string(),
  stagingRoot: z.string()
}

const ProfileClaimCopyingJournalV1Schema = z.strictObject({
  ...ProfileClaimJournalBaseV1Shape,
  phase: z.literal('copying')
})

const ProfileClaimCommittedJournalV1Schema = z.strictObject({
  ...ProfileClaimJournalBaseV1Shape,
  phase: z.literal('committed'),
  committedAt: isoDateTimeSchema
})

export const ProfileClaimJournalV1Schema = z.discriminatedUnion('phase', [
  ProfileClaimCopyingJournalV1Schema,
  ProfileClaimCommittedJournalV1Schema
])

const ProfileBootAttemptV1Schema = z.strictObject({
  number: z.number().int().positive(),
  profileId: profileIdSchema,
  status: z.enum(['started', 'failed', 'succeeded']),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional()
})

export const ProfileBootJournalV1Schema = z.strictObject({
  version: z.literal(1),
  failureCount: z.number().int().nonnegative(),
  lastKnownGood: profileIdSchema.optional(),
  attempt: ProfileBootAttemptV1Schema.optional()
})

export type InstallationRecordV1 = z.infer<typeof InstallationRecordV1Schema>
export type ProfileRecordV1 = z.infer<typeof ProfileRecordV1Schema>
export type ProfileRegistryV1 = z.infer<typeof ProfileRegistryV1Schema>
export type ActiveProfilePointerV1 = z.infer<typeof ActiveProfilePointerV1Schema>
export type ProfileSwitchJournalV1 = z.infer<typeof ProfileSwitchJournalV1Schema>
export type LegacyAdoptionJournalV1 = z.infer<typeof LegacyAdoptionJournalV1Schema>
export type ProfileClaimJournalV1 = z.infer<typeof ProfileClaimJournalV1Schema>
export type ProfileBootJournalV1 = z.infer<typeof ProfileBootJournalV1Schema>
