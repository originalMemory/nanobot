import { MessageSourceBadge } from "@/components/MessageSourceBadge";
import type { MessageSourceFields } from "@/lib/message-source";

interface AssistantNameRowProps {
  botName: string;
  message?: MessageSourceFields;
}

/** assistant 气泡顶行：bot 名称 + 可选来源徽章。 */
export function AssistantNameRow({ botName, message }: AssistantNameRowProps) {
  return (
    <div className="mb-1 flex items-center gap-1 leading-none">
      <span className="text-xs leading-none text-muted-foreground">{botName}</span>
      {message ? <MessageSourceBadge message={message} /> : null}
    </div>
  );
}
