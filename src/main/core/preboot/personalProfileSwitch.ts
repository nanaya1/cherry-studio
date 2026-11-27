import type { PersonalProfile } from './personalProfileLocation'

interface ProfileSwitchDependencies {
  confirmSwitch(): Promise<boolean>
  stopCurrentProfile(): Promise<{ clean: boolean }>
  commitSelection(target: PersonalProfile): void
  relaunch(): void
}

type ProfileSwitchResult = 'cancelled' | 'busy' | 'relaunching'

// MEA:personal-profile-startup Only commit after the previous runtime has stopped.
export class PersonalProfileSwitch {
  private switching = false
  private restartRequired = false

  constructor(private readonly dependencies: ProfileSwitchDependencies) {}

  async switchTo(target: PersonalProfile): Promise<ProfileSwitchResult> {
    if (this.switching || this.restartRequired) return 'busy'
    this.switching = true
    try {
      if (!(await this.dependencies.confirmSwitch())) return 'cancelled'

      // After teardown begins, this process cannot safely serve either profile again.
      this.restartRequired = true
      const stopped = await this.dependencies.stopCurrentProfile()
      if (!stopped.clean) throw new Error('Current profile did not stop cleanly')

      this.dependencies.commitSelection(target)
      this.dependencies.relaunch()
      return 'relaunching'
    } finally {
      this.switching = false
    }
  }
}
