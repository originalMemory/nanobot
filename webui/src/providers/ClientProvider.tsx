import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import type { NanobotClient } from "@/lib/nanobot-client";
import { VoiceProvider } from "./VoiceProvider";
import { CompanionProvider } from "./CompanionProvider";
import type { WebUIIngressLimits } from "@/lib/types";
import type { UIMediaAttachment } from "@/lib/types";
import { getRuntimeHost } from "@/lib/runtime";

interface ClientContextValue {
  client: NanobotClient;
  token: string;
  getToken: () => string;
  modelName: string | null;
  ingressLimits: WebUIIngressLimits | null;
  favoriteMedia: ((attachment: UIMediaAttachment) => Promise<void>) | null;
}

const ClientContext = createContext<ClientContextValue | null>(null);

export function ClientProvider({
  client,
  token,
  modelName = null,
  ingressLimits = null,
  children,
}: {
  client: NanobotClient;
  token: string;
  modelName?: string | null;
  ingressLimits?: WebUIIngressLimits | null;
  children: ReactNode;
}) {
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const getToken = useCallback(() => tokenRef.current, []);
  const favoriteMedia = useMemo(() => getRuntimeHost().surface === "native"
    ? async (attachment: UIMediaAttachment) => {
      if (!attachment.url) throw new Error("Image URL is unavailable");
      await client.requestMutation("media.favorite", { media_url: attachment.url });
    }
    : null, [client]);
  const value = useMemo(
    () => ({ client, token, getToken, modelName, ingressLimits, favoriteMedia }),
    [client, favoriteMedia, getToken, ingressLimits, modelName, token],
  );

  return (
    <ClientContext.Provider value={value}>
      <VoiceProvider><CompanionProvider>{children}</CompanionProvider></VoiceProvider>
    </ClientContext.Provider>
  );
}

export function useClient(): ClientContextValue {
  const ctx = useContext(ClientContext);
  if (!ctx) {
    throw new Error("useClient must be used within a ClientProvider");
  }
  return ctx;
}

export function useFavoriteMedia() {
  return useContext(ClientContext)?.favoriteMedia ?? null;
}
