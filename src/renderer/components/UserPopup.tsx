import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Avatar,
  // [MEA 定向恢复] 原服务端首字头像分支已停用，AvatarFallback 随之停用（保留为注释以满足「原 import 不删除」约定）。
  // AvatarFallback,
  AvatarImage,
  Button,
  ColFlex,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmojiAvatar,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RowFlex
} from '@cherrystudio/ui'
import { usePreference } from '@data/hooks/usePreference'
import useAvatar from '@renderer/hooks/useAvatar'
// [enterprise] T0 企业登录入口
import { useOrgAccountSession } from '@renderer/hooks/useOrgAccountSession'
import { usePersonalAccountDetails } from '@renderer/hooks/usePersonalAccountDetails'
import { ipcApi } from '@renderer/ipc'
import { createPopup, type PopupInjectedProps } from '@renderer/services/popup'
import { toast } from '@renderer/services/toast'
import { checkEntityImageSize, prepareEntityImageBytes } from '@renderer/utils/image'
import { isEmoji } from '@renderer/utils/naming'

import { EmojiPicker } from './EmojiPicker'

interface UserPopupOptions {
  loginOnly?: boolean
  profileOnly?: boolean
}

type Props = PopupInjectedProps<Record<string, never>> & UserPopupOptions

type AvatarPopoverView = 'menu' | 'emoji'

function PersonalAccountActions({ editing, setEditing }: { editing: boolean; setEditing: (editing: boolean) => void }) {
  const { t } = useTranslation()
  const [signedIn, setSignedIn] = useState<boolean>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const { data: personalAccount, mutate: refreshPersonalAccount } = usePersonalAccountDetails(signedIn === true)

  useEffect(() => {
    let active = true
    void ipcApi.request('enterprise.personal.status').then(
      (status) => {
        if (active && status) setSignedIn(status.signedIn)
      },
      () => {
        if (active) setFailed(true)
      }
    )
    return () => {
      active = false
    }
  }, [])

  const changeAccount = async (credentials: { username: string; password: string } | null) => {
    setBusy(true)
    setFailed(false)
    try {
      const result = await ipcApi.request('enterprise.personal.change_account', {
        credentials,
        confirmation: {
          title: t('settings.doctor.actions.relaunch'),
          message: t('settings.general.common.menu.presentation_mode.restart.title'),
          cancel: t('common.cancel'),
          proceed: t('common.confirm')
        }
      })
      if (result === 'updated') {
        if (credentials) void refreshPersonalAccount()
        setEditing(false)
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (signedIn === undefined && !failed) return null

  return (
    <div className={editing ? 'px-5 pt-2 pb-5' : 'border-border-subtle border-t px-5 py-4'}>
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            void changeAccount({ username: String(data.get('username')), password: String(data.get('password')) })
          }}>
          <Input
            name="username"
            autoComplete="username"
            aria-label={t('library.config.prompt.vars.username')}
            placeholder={t('library.config.prompt.vars.username')}
            required
            maxLength={60}
            disabled={busy}
          />
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            aria-label={t('settings.provider.basic_auth.password.label')}
            placeholder={t('settings.provider.basic_auth.password.label')}
            required
            maxLength={72}
            disabled={busy}
          />
          <Button type="submit" loading={busy}>
            {t('settings.provider.org_service.login')}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          {personalAccount && (
            <div className="min-w-0">
              <div className="truncate font-medium text-sm">{personalAccount.displayName}</div>
              {personalAccount.displayName !== personalAccount.username && (
                <div className="truncate text-muted-foreground text-xs">{personalAccount.username}</div>
              )}
            </div>
          )}
          <div className={signedIn ? 'grid grid-cols-2 gap-2' : 'grid'}>
            <Button className="flex-1" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
              {t(signedIn ? 'settings.provider.org_service.switch_account' : 'settings.provider.org_service.login')}
            </Button>
            {signedIn && (
              <Button variant="ghost" loading={busy} onClick={() => void changeAccount(null)}>
                {t('settings.provider.org_service.logout')}
              </Button>
            )}
          </div>
        </div>
      )}
      {failed && (
        <p className="pt-2 text-error-subtle-foreground text-xs" role="alert">
          {t('settings.provider.org_service.login_failed')}
        </p>
      )}
    </div>
  )
}

const PopupContainer: React.FC<Props> = ({ open, resolve, loginOnly = false, profileOnly = false }) => {
  const [editingAccount, setEditingAccount] = useState(loginOnly)
  const [userName, setUserName] = usePreference('app.user.name')
  // The stored name is always trimmed; the draft keeps the raw text so a space can be typed
  // mid-name, and stays unset until typed so the input follows the preference until then.
  const [userNameDraft, setUserNameDraft] = useState<string>()
  // [MEA 定向恢复] 姓名头像只用本地设置，不再用服务端资料：原 avatarPreference 仅用于「服务端首字头像」分支，现已停用。
  // const [avatarPreference] = usePreference('app.user.avatar')

  const [avatarPopoverOpen, setAvatarPopoverOpen] = useState(false)
  const [avatarPopoverView, setAvatarPopoverView] = useState<AvatarPopoverView>('menu')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { t } = useTranslation()
  const avatar = useAvatar()
  // 「登录 / 退出樱桃云」入口暂时隐藏，详见下方对应 JSX 注释。
  // const isCnEdition = getAppEdition() === 'cn'
  // const {
  //   status: cloudStatus,
  //   loadState: cloudStatusLoadState,
  //   reload: loadCloudStatus,
  //   login: handleCloudLogin,
  //   cancelLogin: handleCloudLoginCancel,
  //   revokeSession: handleCloudLogout,
  //   isCancellingLogin,
  //   isRevokingSession,
  //   isAuthorizing
  // } = useCherryAccountSession(open)

  // [enterprise] T0 企业服务登录状态（登录走系统浏览器，回调经 meacowork://auth 深链）
  const {
    status: orgStatus,
    loadState: orgLoadState,
    reload: loadOrgStatus,
    login: handleOrgLogin,
    logout: handleOrgLogout,
    cancelLogin: handleOrgLoginCancel,
    isCancellingLogin: isOrgCancellingLogin,
    waitHintVisible,
    loginError,
    isLoggingIn: isOrgLoggingIn,
    isLoggingOut: isOrgLoggingOut,
    // [enterprise] C3：登出后 org 资源标记"组织不可用"，重登自动恢复
    orgUnavailable
  } = useOrgAccountSession(open)
  // [MEA 定向恢复] 姓名头像只用本地设置，不再用服务端资料：原 signedInDisplayName 用于「服务端首字头像」与「输入框禁用+覆盖」分支，现已停用。
  // const signedInDisplayName = orgStatus?.phase === 'signed-in' ? orgStatus.displayName?.trim() : undefined

  const onOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setEditingAccount(false)
      resolve({})
    }
  }

  // The `profile.set_avatar` handler owns the `app.user.avatar` Preference write;
  // the Preference auto-syncs back to `useAvatar`, so these flows don't write the
  // value themselves. A superseded file_entry is left for the orphan sweep, not
  // pruned here.
  const handleEmojiClick = async (emoji: string) => {
    try {
      await ipcApi.request('profile.set_avatar', { kind: 'emoji', emoji })
      setAvatarPopoverOpen(false)
      setAvatarPopoverView('menu')
    } catch (error: any) {
      toast.error(error.message)
    }
  }

  const handleReset = async () => {
    try {
      // Reset falls back to the bundled default avatar (see useAvatar).
      await ipcApi.request('profile.set_avatar', { kind: 'default' })
      setAvatarPopoverOpen(false)
      setAvatarPopoverView('menu')
    } catch (error: any) {
      toast.error(error.message)
    }
  }

  const handleUploadAvatar = async (file: File) => {
    const sizeError = checkEntityImageSize(file)
    if (sizeError) {
      toast.error(sizeError)
      return
    }
    try {
      // Normalize to a 128² WebP in the renderer, then send the small payload; the
      // handler creates the file_entry and stores a `file:<id>` ref in the Preference
      // (the avatar has no file_ref table). A processing failure throws a localized
      // retry message.
      const data = await prepareEntityImageBytes(file)
      await ipcApi.request('profile.set_avatar', { kind: 'image', data })
      setAvatarPopoverOpen(false)
      setAvatarPopoverView('menu')
    } catch (error: any) {
      toast.error(error.message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-[300px] gap-0 p-0 sm:max-w-[300px]">
        <DialogHeader className={editingAccount ? 'px-5 pt-5 pb-2 pr-12' : 'sr-only'}>
          <DialogTitle>{t(editingAccount ? 'settings.provider.org_service.login' : 'workspace.localUser')}</DialogTitle>
        </DialogHeader>
        {!editingAccount && (
          <div className="flex flex-col items-center gap-5 px-5 pt-[30px] pb-5">
            <Popover
              open={avatarPopoverOpen}
              onOpenChange={(visible) => {
                setAvatarPopoverOpen(visible)
                if (!visible) {
                  setAvatarPopoverView('menu')
                }
              }}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={t('common.avatar')}
                  className="size-20 shrink-0 rounded-[25%] p-0 text-foreground shadow-none transition-opacity hover:bg-transparent hover:text-foreground hover:opacity-80 focus-visible:bg-transparent focus-visible:opacity-80">
                  {/* [MEA 定向恢复] 原逻辑：signedInDisplayName && !avatarPreference 时显示服务端首字头像；现停用，只用本地 emoji/图片头像。
                  {signedInDisplayName && !avatarPreference ? (
                    <Avatar className="size-20 rounded-[25%]">
                      <AvatarFallback className="bg-linear-to-br from-blue-400 to-indigo-500 text-2xl text-white">
                        {signedInDisplayName.slice(0, 1).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  ) : isEmoji(avatar) ? (
                    <EmojiAvatar size={80} fontSize={40}>
                      {avatar}
                    </EmojiAvatar>
                  ) : (
                    <Avatar className="size-20 rounded-[25%]">
                      <AvatarImage src={avatar} className="object-cover" />
                    </Avatar>
                  )} */}
                  {isEmoji(avatar) ? (
                    <EmojiAvatar size={80} fontSize={40}>
                      {avatar}
                    </EmojiAvatar>
                  ) : (
                    <Avatar className="size-20 rounded-[25%]">
                      <AvatarImage src={avatar} className="object-cover" />
                    </Avatar>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-2" align="center" sideOffset={6}>
                {avatarPopoverView === 'emoji' ? (
                  <EmojiPicker onEmojiClick={handleEmojiClick} />
                ) : (
                  <ColFlex className="w-40 gap-1">
                    <input
                      ref={fileInputRef}
                      className="hidden"
                      type="file"
                      accept="image/png, image/jpeg, image/gif, image/webp"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        if (file) {
                          void handleUploadAvatar(file)
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      className="w-full justify-center"
                      onClick={() => fileInputRef.current?.click()}>
                      {t('settings.general.image_upload')}
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full justify-center"
                      onClick={() => setAvatarPopoverView('emoji')}>
                      {t('settings.general.emoji_picker')}
                    </Button>
                    <Button variant="ghost" className="w-full justify-center" onClick={() => void handleReset()}>
                      {t('settings.general.avatar.reset')}
                    </Button>
                  </ColFlex>
                )}
              </PopoverContent>
            </Popover>
            {/* [MEA 定向恢复] 原逻辑：signedInDisplayName 存在时占位符清空、value 用服务端名、输入框禁用；现停用，姓名只走本地 app.user.name 且始终可编辑（保留输入空格修复与草稿逻辑）。
          <Input
            placeholder={signedInDisplayName ? undefined : t('settings.general.user_name.placeholder')}
            value={signedInDisplayName || (userNameDraft ?? userName)}
            onChange={
              signedInDisplayName
                ? undefined
                : (e) => {
                    setUserNameDraft(e.target.value)
                    void setUserName(e.target.value.trim())
                  }
            }
            disabled={Boolean(signedInDisplayName)}
            className="w-full flex-1 text-center disabled:cursor-default disabled:opacity-100"
            maxLength={30}
          /> */}
            <Input
              aria-label={t('settings.general.user_name.label')}
              placeholder={t('settings.general.user_name.placeholder')}
              value={userNameDraft ?? userName}
              onChange={(e) => {
                setUserNameDraft(e.target.value)
                void setUserName(e.target.value.trim())
              }}
              className="w-full text-center"
              maxLength={30}
            />
          </div>
        )}
        {open && !profileOnly && (
          <PersonalAccountActions
            editing={editingAccount}
            setEditing={loginOnly ? () => resolve({}) : setEditingAccount}
          />
        )}
        {/* 「登录 / 退出樱桃云」入口暂时隐藏：连接 cloud.cherryai.com(.cn) 走 Cherry 厂商云。Mea Cowork 暂不开放登录。 */}
        {/*
        {isCnEdition || cloudStatus?.phase === 'signed-in' ? (
          <RowFlex className="border-border-subtle border-t px-5 py-4">
            {cloudStatusLoadState === 'error' ? (
              <ColFlex className="w-full gap-2">
                <div
                  role="alert"
                  className="rounded-lg border border-error-border bg-error-subtle px-3 py-2 text-center text-error-subtle-foreground text-xs">
                  {t('error.http.503')}
                </div>
                <Button className="w-full" onClick={() => void loadCloudStatus()} variant="outline">
                  {t('common.retry')}
                </Button>
              </ColFlex>
            ) : cloudStatus?.phase === 'signed-in' ? (
              <ColFlex className="w-full items-center gap-1.5">
                <Button
                  className="w-full"
                  loading={isRevokingSession}
                  onClick={() => void handleCloudLogout()}
                  variant="outline">
                  {t('settings.provider.cherry_cloud.logout')}
                </Button>
                {cloudStatus.displayName ? (
                  <div role="status" className="max-w-full truncate text-foreground-tertiary text-xs leading-tight">
                    {cloudStatus.displayName}
                  </div>
                ) : null}
              </ColFlex>
            ) : (
              <ColFlex className="w-full gap-2">
                <Button
                  className="w-full"
                  loading={cloudStatusLoadState === 'loading' || isAuthorizing}
                  onClick={() => void handleCloudLogin()}
                  variant="emphasis">
                  {isAuthorizing
                    ? t('settings.provider.cherry_cloud.signing_in')
                    : t('settings.provider.cherry_cloud.login')}
                </Button>
                {isAuthorizing ? (
                  <Button
                    className="w-full"
                    loading={isCancellingLogin}
                    onClick={() => void handleCloudLoginCancel()}
                    variant="outline">
                    {t('common.cancel')}
                  </Button>
                ) : null}
              </ColFlex>
            )}
          </RowFlex>
        ) : null}
        */}
        {/* [enterprise] 官网账户登录入口（樱桃云入口同款布局） */}
        {/* 隐藏未登录/授权中的入口，保留已有会话的退出及状态重试。 */}
        {/* 原条件：orgLoadState !== 'loading' */}
        {!profileOnly &&
        !editingAccount &&
        orgLoadState !== 'loading' &&
        (orgLoadState === 'error' || orgStatus?.phase === 'signed-in') ? (
          <RowFlex className="border-border-subtle border-t px-5 py-4">
            {orgLoadState === 'error' ? (
              <ColFlex className="w-full gap-2">
                <div
                  role="alert"
                  className="rounded-lg border border-error-border bg-error-subtle px-3 py-2 text-center text-error-subtle-foreground text-xs">
                  {t('error.http.503')}
                </div>
                <Button className="w-full" onClick={() => void loadOrgStatus()} variant="outline">
                  {t('common.retry')}
                </Button>
              </ColFlex>
            ) : orgStatus ? (
              orgStatus.phase === 'signed-in' ? (
                <ColFlex className="w-full items-center gap-1.5">
                  <Button
                    className="w-full"
                    loading={isOrgLoggingOut}
                    onClick={() => void handleOrgLogout()}
                    variant="outline">
                    {/* 原硬编码：退出登录 */}
                    {t('settings.provider.org_service.logout')}
                  </Button>
                  {orgStatus.phone ? (
                    <div role="status" className="max-w-full truncate text-foreground-tertiary text-xs leading-tight">
                      {orgStatus.phone}
                      {/* 原硬编码： · 管理员 */}
                      {orgStatus.role === 'super_admin' ? t('settings.provider.org_service.admin_suffix') : ''}
                    </div>
                  ) : null}
                </ColFlex>
              ) : (
                <ColFlex className="w-full gap-2">
                  {/* [enterprise] C3：登出后企业技能/连接器标记"组织不可用"（本地保留，重登恢复） */}
                  {orgUnavailable ? (
                    <div
                      role="status"
                      className="rounded-lg border border-border-subtle bg-secondary px-3 py-2 text-center text-foreground-tertiary text-xs leading-tight">
                      {/* 原硬编码：企业技能与连接器暂不可用（已退出登录），重新登录后自动恢复 */}
                      {t('library.org_skill.unavailable_notice')}
                    </div>
                  ) : null}
                  <Button
                    className="w-full"
                    loading={isOrgLoggingIn}
                    disabled={isOrgLoggingIn || orgStatus.phase === 'authorizing'}
                    onClick={() => void handleOrgLogin()}
                    variant="emphasis">
                    {/* 原硬编码：等待浏览器授权… / 登录 */}
                    {isOrgLoggingIn || orgStatus.phase === 'authorizing'
                      ? t('settings.provider.org_service.signing_in')
                      : t('settings.provider.org_service.login')}
                  </Button>
                  {isOrgLoggingIn ? (
                    <>
                      <div role="status" className="text-center text-foreground-tertiary text-xs leading-tight">
                        {t(
                          waitHintVisible
                            ? 'settings.provider.org_service.login_wait_hint'
                            : 'settings.provider.org_service.login_browser_hint'
                        )}
                      </div>
                      {waitHintVisible ? (
                        <div className="text-center text-foreground-tertiary text-xs leading-tight">
                          {t('settings.provider.org_service.login_browser_hint')}
                        </div>
                      ) : null}
                      <Button
                        className="w-full"
                        variant="outline"
                        loading={isOrgCancellingLogin}
                        disabled={!orgStatus.loginAttemptId}
                        onClick={() => void handleOrgLoginCancel()}>
                        {t('common.cancel')}
                      </Button>
                    </>
                  ) : loginError ? (
                    <div
                      role="alert"
                      className="rounded-lg border border-error-border bg-error-subtle px-3 py-2 text-center text-error-subtle-foreground text-xs">
                      {t(
                        loginError === 'timeout'
                          ? 'settings.provider.org_service.login_timeout'
                          : loginError === 'denied'
                            ? 'settings.provider.org_service.login_denied'
                            : 'settings.provider.org_service.login_failed'
                      )}
                    </div>
                  ) : null}
                </ColFlex>
              )
            ) : null}
          </RowFlex>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const UserPopup = createPopup<UserPopupOptions, Record<string, never>>(PopupContainer, { dismissResult: {} })

export default UserPopup
