import { SettingsContentColumn } from '@renderer/components/SettingsPrimitives'
import { UserProfileEditor } from '@renderer/components/UserProfileEditor'

export function ProfileSettings() {
  return (
    <SettingsContentColumn>
      <div className="space-y-6">
        <div id="setting-profile-profile">
          <UserProfileEditor />
        </div>
      </div>
    </SettingsContentColumn>
  )
}
