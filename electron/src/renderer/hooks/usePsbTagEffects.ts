import { useCallback, useRef } from "react";

import type { SettingsPayload, UIMessage } from "@/lib/types";

import {
  markMessagesPsbTagsSynced,
} from "../../psb/tag-sync";

/**
 * Compatibility hook for old PSB tag side effects.
 *
 * Runtime actions are now driven by server-generated assistant playback
 * segments, so this hook only prevents historical messages from being
 * reprocessed by older callers.
 */
export function usePsbTagEffects(
  messages: UIMessage[],
  _settings: SettingsPayload | null | undefined,
  turnEndRef: React.MutableRefObject<() => void>,
  skipHistoryRef: React.MutableRefObject<() => void>,
  _isStreaming: boolean,
): void {
  void _isStreaming;
  const syncedCountsRef = useRef(new Map<string, number>());
  const messagesRef = useRef(messages);
  const initialHistoryMarkedRef = useRef(false);

  messagesRef.current = messages;

  if (!initialHistoryMarkedRef.current) {
    initialHistoryMarkedRef.current = true;
    markMessagesPsbTagsSynced(messages, syncedCountsRef.current);
  }

  skipHistoryRef.current = useCallback(() => {
    markMessagesPsbTagsSynced(messagesRef.current, syncedCountsRef.current);
  }, []);

  turnEndRef.current = useCallback(() => {
    markMessagesPsbTagsSynced(messagesRef.current, syncedCountsRef.current);
  }, []);
}
