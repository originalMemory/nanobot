import { useEffect, useState } from "react";

import type {
  ChatModelPresetSnapshot,
  NanobotClient,
} from "@/lib/nanobot-client";

interface ChatModelPresetState extends ChatModelPresetSnapshot {
  chatId: string | null;
}

export function useChatModelPreset(
  client: NanobotClient,
  chatId: string | null,
  fallbackPreset: string | null = null,
): ChatModelPresetSnapshot {
  const read = (): ChatModelPresetState => {
    if (!chatId) return { chatId: null, hydrated: true, preset: null };
    const snapshot = client.getChatModelPresetSnapshot(chatId);
    return { chatId, ...snapshot };
  };
  const [state, setState] = useState<ChatModelPresetState>(read);

  useEffect(() => {
    if (!chatId) {
      setState({ chatId: null, hydrated: true, preset: null });
      return;
    }
    return client.onChatModelPreset(chatId, (snapshot) => {
      setState({ chatId, ...snapshot });
    });
  }, [chatId, client]);

  const current = state.chatId === chatId ? state : read();
  return {
    hydrated: current.hydrated,
    preset: current.hydrated ? current.preset : fallbackPreset,
  };
}
