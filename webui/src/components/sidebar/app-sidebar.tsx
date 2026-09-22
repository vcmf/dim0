import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from '@/components/ui/sidebar'
import { useInfiniteChats } from '@/features/agent/api/list-chats'
import { useAppStore } from '@/store'
import { isSignedIn } from '@/lib/auth'
import { isTauri } from '@/platform'
import { SignInCta } from '@/features/desktop/sign-in-cta'
import { useListBoards } from '@/features/board/api/list-boards'
import { useLocalBoards } from '@/features/board/local/use-local-boards'
import { useEnableSync } from '@/features/board/local/use-enable-sync'
import { selectOnDeviceBoards } from '@/features/board/screens/partition-boards'
import { ChatMenuItem, NewChatItem } from './chat'
import { BoardItem, DashboardMenuItem, LocalBoardItem, NewLocalBoardItem } from './board'
import { ChatsDialog } from './chats-dialog'
import { useMemo, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import type { Chat } from '@/features/agent/types/chat'
import { AwardIcon, ChatHistoryIcon, InstallAppIcon, LogoutIcon, UserProfileIcon } from '@/components/icons'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ModeToggle } from '@/components/mode-toggle'
import { HomeMenuItem } from './home'
import { useNavigate } from '@tanstack/react-router'
import { TierBadge } from '@/features/user-settings/components/tier-badge'


/**
 * Props for the AppSidebar component.
 *
 * @property onLogout - Callback function to handle user logout.
 */
type AppSidebarProps = {
  onLogout: () => void
}


/**
 * Application Sidebar Component.
 */
const CHAT_HISTORY_PAGE_SIZE = 50

export function AppSidebar({ onLogout }: AppSidebarProps) {
  const navigate = useNavigate()
  const userId = useAppStore(s => s.userId)
  const userEmail = useAppStore(s => s.userEmail)
  const userPlan = useAppStore(s => s.userPlan)
  const billingActive = useAppStore(s => s.billingActive)
  // Signed-out ("root") gets the same shell but a local-only nav: no Dashboard/
  // Chats (both need the backend), and a sign-in CTA instead of the account menu.
  const signedIn = isSignedIn(userId)

  const initials = useMemo(() => {
    if (!userEmail) return 'U'
    const name = userEmail.split('@')[0] || 'user'
    return name.slice(0, 2).toUpperCase()
  }, [userEmail])

  const [chatsDialogOpen, setChatsDialogOpen] = useState(false)

  const { data: chatPagesData } = useInfiniteChats({
    pageSize: CHAT_HISTORY_PAGE_SIZE,
    graphUid: "any",
    userId
  })
  const { data: boards = [] } = useListBoards(userId)
  const { boards: localBoards, createBoard, deleteBoard, refresh } = useLocalBoards()
  const { enableSync, pendingId } = useEnableSync()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  const chatHistoryItems = useMemo<Chat[]>(
    () => chatPagesData?.pages.flat() ?? [],
    [chatPagesData]
  )

  const openLocal = (id: string): void => {
    void navigate({ to: "/local/$boardId", params: { boardId: id } })
  }

  const handleNewLocal = async (): Promise<void> => {
    const meta = await createBoard("Untitled board")
    if (meta) openLocal(meta.id)
  }

  // Only truly-local boards belong here; a promoted board appears in the SYNCED
  // group (from the backend list) instead. Share the dashboard's on-device rule
  // so both surfaces dedupe identically (see selectOnDeviceBoards): dropped once
  // present in the backend list, and a synced replica shows only for its
  // signed-in owner (never leaks to another session).
  const localOnly = useMemo(
    () => selectOnDeviceBoards(localBoards, boards, userId),
    [localBoards, boards, userId],
  )

  const localBoardItems = useMemo(
    () =>
      localOnly.map((b) => {
        const active = pathname === `/local/${b.id}` || pathname.startsWith(`/local/${b.id}/`)
        return (
          <LocalBoardItem
            key={b.id}
            boardId={b.id}
            label={b.title}
            isActive={active}
            syncing={pendingId === b.id}
            onOpen={() => openLocal(b.id)}
            onEnableSync={() => {
              void enableSync(b.id, b.title).then((r) => {
                if (r.ok) void refresh()
              })
            }}
            // Deleting the board you're currently viewing must leave that route,
            // else the view sits on a now-deleted local board. Mirrors the synced
            // BoardItem's active-delete navigation, but picks the target by auth: a
            // signed-out user can't reach `/boards` (it's `requireVerifiedAuth` and
            // bounces to /signin), so route them to the unguarded local dashboard.
            onDelete={() => {
              void deleteBoard(b.id)
              if (active) void navigate({ to: signedIn ? "/boards" : "/local" })
            }}
          />
        )
      }),
    // openLocal/enableSync/deleteBoard/refresh are stable enough for this list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [localOnly, pathname, pendingId, signedIn],
  )

  const chatItems = useMemo(
    () => chatHistoryItems.map(chat => (
      <ChatMenuItem key={chat.uid} chatId={chat.uid} label={chat.label} />
    )),
    [chatHistoryItems]
  )

  const { myBoards, sharedBoards } = useMemo(() => {
    const mine: typeof boards = []
    const shared: typeof boards = []
    for (const board of boards) {
      if (board.role === "owner") {
        mine.push(board)
      } else {
        shared.push(board)
      }
    }
    return { myBoards: mine, sharedBoards: shared }
  }, [boards])

  const myBoardItems = useMemo(
    () =>
      myBoards.map((board) => (
        <BoardItem key={board.uid} boardId={board.uid} label={board.label} />
      )),
    [myBoards],
  )

  const sharedBoardItems = useMemo(
    () =>
      sharedBoards.map((board) => (
        <BoardItem
          key={board.uid}
          boardId={board.uid}
          label={board.label}
          sharedByEmail={board.ownerEmail}
        />
      )),
    [sharedBoards],
  )

  return (
    <Sidebar variant="sidebar" collapsible="offcanvas">
      <SidebarContent className="w-full h-full flex flex-col overflow-hidden">
        {/* On desktop the brand lives in the title line (and "Install app" makes
            no sense inside the installed app), so this header is web-only. */}
        {!isTauri() && (
          <SidebarGroup className="shrink-0">
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <div className="flex items-center gap-2">
                    <SidebarMenuButton
                      className="h-auto py-2 min-w-0 flex-1"
                      onClick={() => navigate({ to: "/" })}
                    >
                      <img src="/dim0.svg" alt="Dim0 Home" className="h-7 w-7 shrink-0" />
                      <span className="font-medium">Dim0</span>
                    </SidebarMenuButton>

                    <button
                      type="button"
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      onClick={() => navigate({ to: "/install" })}
                      aria-label="Install app"
                      title="Install app"
                    >
                      <InstallAppIcon className="size-4" strokeWidth={2} />
                    </button>
                  </div>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Desktop: clear the title line at the sidebar's top (no web-only header). */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin [.tauri:not(.tauri-fullscreen)_&]:pt-11">
          <div className="pb-0">
            <SidebarGroup>
              <SidebarGroupLabel><span>WORKSPACE</span></SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <HomeMenuItem />
                  {signedIn && <DashboardMenuItem />}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel><span>LOCAL</span></SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <NewLocalBoardItem onClick={() => void handleNewLocal()} />
                  {localBoardItems}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            {myBoardItems.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel><span>SYNCED</span></SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {myBoardItems}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {sharedBoardItems.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel><span>SHARED WITH ME</span></SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {sharedBoardItems}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {signedIn && (
              <SidebarGroup>
                <SidebarGroupLabel><span>CHATS</span></SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <NewChatItem />
                    <SidebarMenuSub>
                      {chatItems}
                    </SidebarMenuSub>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={() => setChatsDialogOpen(true)}
                        className="font-medium text-xs"
                      >
                        <ChatHistoryIcon className="size-4 shrink-0" strokeWidth={2} />
                        <span>View all chats</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </div>
        </div>

        <ChatsDialog open={chatsDialogOpen} onOpenChange={setChatsDialogOpen} />

        <SidebarGroup className="shrink-0 border-t border-sidebar-border/50 pt-2">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <div className="flex items-center gap-2 w-full">
                  {signedIn ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuButton className="h-auto py-2 flex items-center gap-2 font-medium text-xs min-w-0 flex-1">
                          <Avatar className="h-8 w-8 -ml-2 shrink-0">
                            <AvatarImage alt={userEmail} />
                            <AvatarFallback>{initials}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <span
                              className="truncate block"
                              title={userEmail}
                            >
                              {userEmail}
                            </span>
                            {billingActive ? (
                              <div className="mt-1">
                                <TierBadge plan={userPlan} />
                              </div>
                            ) : null}
                          </div>
                        </SidebarMenuButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="top" className="w-56">
                        <DropdownMenuItem
                          className='text-xs'
                          onClick={() => navigate({ to: "/settings" })}
                        >
                          <UserProfileIcon className="mr-2 h-4 w-4" strokeWidth={2} />
                          <span>Profile</span>
                        </DropdownMenuItem>
                        {billingActive ? (
                          <DropdownMenuItem
                            className='text-xs bg-gradient-to-br from-secondary-foreground/10 via-secondary-foreground/5 to-transparent text-secondary-foreground'
                            onClick={() => navigate({ to: "/settings/billing" })}
                          >
                            <AwardIcon className="mr-2 h-4 w-4 text-secondary-foreground" strokeWidth={2} />
                            <span>Upgrade Plan</span>
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={onLogout} className='text-xs'>
                          <LogoutIcon className="mr-2 h-4 w-4" strokeWidth={2} />
                          <span>Logout</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <SignInCta />
                  )}

                  <div className="ml-auto shrink-0 pt-1">
                    <ModeToggle aria-label="Toggle theme" />
                  </div>
                </div>
              </SidebarMenuItem>
            </SidebarMenu>
            <div className="px-2 w-full text-center text-[11px] text-muted-foreground">
              v{__APP_VERSION__}
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
