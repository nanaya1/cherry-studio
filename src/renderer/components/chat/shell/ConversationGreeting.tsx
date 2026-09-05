export interface ConversationGreetingProps {
  title: string
}

/** Welcome state for an empty chat or agent conversation. */
export function ConversationGreeting({ title }: ConversationGreetingProps) {
  return (
    <div
      data-testid="conversation-greeting"
      className="grid h-full w-full grid-rows-[40%_1fr] justify-items-center px-6 text-center">
      <h2 className="m-0 self-end font-medium text-foreground text-lg">{title}</h2>
    </div>
  )
}

export default ConversationGreeting
