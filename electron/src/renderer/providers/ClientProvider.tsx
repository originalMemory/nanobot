import { createContext, useContext, type ReactNode } from "react";

import type { NanobotClient } from "@/lib/nanobot-client";

interface ClientContextValue {
  client: NanobotClient;
  token: string;
  modelName: string | null;
  /** Gateway HTTP base URL，如 "http://127.0.0.1:8765"，用于把相对路径 /api/... 拼成绝对 URL */
  apiBase: string;
}

const ClientContext = createContext<ClientContextValue | null>(null);

export function ClientProvider({
  client,
  token,
  modelName = null,
  apiBase,
  children,
}: {
  client: NanobotClient;
  token: string;
  modelName?: string | null;
  apiBase: string;
  children: ReactNode;
}) {
  return (
    <ClientContext.Provider value={{ client, token, modelName, apiBase }}>
      {children}
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
